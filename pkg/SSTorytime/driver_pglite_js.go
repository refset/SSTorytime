// pglite-js: a database/sql driver that bridges Go to PGlite running
// in the same browser tab via syscall/js. Registered as "pglite-js"
// so callers can do sql.Open("pglite-js", "") and get back a *sql.DB
// that drops into the existing PoSST.DB field with no upstream code
// changes.
//
// Build constraint keeps this file out of native builds entirely;
// `go build ./pkg/SSTorytime` on linux/amd64 won't even see it.
//
// Architecture:
//   - JS side exposes window.__sstQuery(sql, paramsJSON) -> Promise
//     that resolves to { columns, types, rows, affectedRows }.
//   - Go side calls it via syscall/js, converts the returned Promise
//     into a channel-blocking await (Promise.then/catch callbacks
//     send on a Go channel; the calling goroutine reads it).
//   - WASM runs on the main thread but Go's cooperative scheduler
//     yields between goroutines, so the JS event loop keeps turning
//     and the Promise resolves normally. No Worker, no SAB, no
//     Atomics needed.
//
// Type mapping (returned to database/sql as driver.Value):
//   - bool (OID 16)                       -> bool
//   - int2/int4/int8 (21/23/20)           -> int64
//   - float4/float8 (700/701)             -> float64
//   - everything else (text, tsvector,
//     user composites, arrays)            -> string
// Upstream's existing scan-into-string + ParseSQL* helpers in
// tools.go handle composite/array text directly, so we don't need
// to decode them in the driver.

//go:build js && wasm

package SSTorytime

import (
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"syscall/js"
	"time"
)

func init() {
	sql.Register("pglite-js", &pgliteDriver{})
}

// ----- driver.Driver -----

type pgliteDriver struct{}

func (d *pgliteDriver) Open(name string) (driver.Conn, error) {
	// PGlite is a singleton living in JS; the DSN is ignored. We do
	// verify the JS-side bridge is available — otherwise a confusing
	// "undefined is not a function" surfaces on first Query.
	if !js.Global().Get("__sstQuery").Truthy() {
		return nil, errors.New("pglite-js: window.__sstQuery is not defined; bridge.js must run before sql.Open")
	}
	return &pgliteConn{}, nil
}

// ----- driver.Conn -----

type pgliteConn struct{ closed bool }

func (c *pgliteConn) Prepare(query string) (driver.Stmt, error) {
	if c.closed {
		return nil, driver.ErrBadConn
	}
	return &pgliteStmt{conn: c, query: query}, nil
}

func (c *pgliteConn) Close() error {
	c.closed = true
	return nil
}

// Begin/Commit/Rollback issue real BEGIN/COMMIT/ROLLBACK against
// PGlite. PGlite supports transactional semantics on the same
// connection; since database/sql gives us serialized access per
// connection there's no concurrency hazard.
func (c *pgliteConn) Begin() (driver.Tx, error) {
	if _, err := c.exec("BEGIN", nil); err != nil {
		return nil, err
	}
	return &pgliteTx{conn: c}, nil
}

// exec/query are the underlying calls; both go through __sstQuery and
// differ only in how they shape the response for database/sql.
func (c *pgliteConn) exec(query string, args []driver.Value) (driver.Result, error) {
	resp, err := c.call(query, args)
	if err != nil {
		return nil, err
	}
	return &pgliteResult{rowsAffected: resp.affectedRows}, nil
}

func (c *pgliteConn) query(query string, args []driver.Value) (driver.Rows, error) {
	resp, err := c.call(query, args)
	if err != nil {
		return nil, err
	}
	return &pgliteRows{cols: resp.columns, oids: resp.types, rows: resp.rows, pos: 0}, nil
}

// queryResponse is what we get back from a __sstQuery call after
// awaiting its Promise.
type queryResponse struct {
	columns       []string
	types         []int   // Postgres OIDs, parallel to columns
	rows          [][]js.Value
	affectedRows  int64
}

func (c *pgliteConn) call(query string, args []driver.Value) (queryResponse, error) {
	if c.closed {
		return queryResponse{}, driver.ErrBadConn
	}
	paramsJSON, err := encodeArgs(args)
	if err != nil {
		return queryResponse{}, fmt.Errorf("pglite-js: encode args: %w", err)
	}
	promise := js.Global().Call("__sstQuery", query, paramsJSON)
	v, err := awaitPromise(promise)
	if err != nil {
		return queryResponse{}, fmt.Errorf("pglite-js: %w", err)
	}
	return readResponse(v), nil
}

// ----- driver.Stmt -----

type pgliteStmt struct {
	conn  *pgliteConn
	query string
}

func (s *pgliteStmt) Close() error  { return nil }
func (s *pgliteStmt) NumInput() int { return -1 } // let database/sql skip the check

func (s *pgliteStmt) Exec(args []driver.Value) (driver.Result, error) {
	return s.conn.exec(s.query, args)
}

func (s *pgliteStmt) Query(args []driver.Value) (driver.Rows, error) {
	return s.conn.query(s.query, args)
}

// ----- driver.Tx -----

type pgliteTx struct{ conn *pgliteConn }

func (t *pgliteTx) Commit() error {
	_, err := t.conn.exec("COMMIT", nil)
	return err
}
func (t *pgliteTx) Rollback() error {
	_, err := t.conn.exec("ROLLBACK", nil)
	return err
}

// ----- driver.Result -----

type pgliteResult struct{ rowsAffected int64 }

func (r *pgliteResult) LastInsertId() (int64, error) {
	// Postgres has no implicit last-insert-id; callers that need it
	// must use INSERT ... RETURNING. lib/pq returns the same error.
	return 0, errors.New("pglite-js: LastInsertId not supported (use INSERT ... RETURNING)")
}
func (r *pgliteResult) RowsAffected() (int64, error) { return r.rowsAffected, nil }

// ----- driver.Rows -----

type pgliteRows struct {
	cols []string
	oids []int
	rows [][]js.Value
	pos  int
}

func (r *pgliteRows) Columns() []string { return r.cols }
func (r *pgliteRows) Close() error      { return nil }

func (r *pgliteRows) Next(dest []driver.Value) error {
	if r.pos >= len(r.rows) {
		return io.EOF
	}
	row := r.rows[r.pos]
	r.pos++
	for i := range dest {
		oid := 0
		if i < len(r.oids) {
			oid = r.oids[i]
		}
		v, err := jsToDriverValue(row[i], oid)
		if err != nil {
			return fmt.Errorf("pglite-js: column %q (oid %d): %w", r.cols[i], oid, err)
		}
		dest[i] = v
	}
	return nil
}

// ----- helpers -----

// awaitPromise turns a JS Promise into a synchronous Go call by
// registering then/catch callbacks that send on a channel. The
// goroutine receiving from the channel yields to Go's scheduler,
// which yields to the JS event loop, which lets the Promise resolve.
func awaitPromise(p js.Value) (js.Value, error) {
	type result struct {
		v   js.Value
		err error
	}
	ch := make(chan result, 1)
	var thenCb, catchCb js.Func
	thenCb = js.FuncOf(func(_ js.Value, args []js.Value) any {
		var v js.Value
		if len(args) > 0 {
			v = args[0]
		}
		ch <- result{v: v}
		return nil
	})
	catchCb = js.FuncOf(func(_ js.Value, args []js.Value) any {
		msg := "promise rejected"
		if len(args) > 0 {
			a := args[0]
			switch a.Type() {
			case js.TypeString:
				msg = a.String()
			case js.TypeObject:
				if m := a.Get("message"); m.Type() == js.TypeString {
					msg = m.String()
				}
			}
		}
		ch <- result{err: errors.New(msg)}
		return nil
	})
	p.Call("then", thenCb).Call("catch", catchCb)
	r := <-ch
	thenCb.Release()
	catchCb.Release()
	return r.v, r.err
}

// encodeArgs turns a Go args slice into a JSON string the JS side
// can JSON.parse and pass to PGlite's positional ($1, $2, ...) params.
func encodeArgs(args []driver.Value) (string, error) {
	if len(args) == 0 {
		return "[]", nil
	}
	out := make([]any, len(args))
	for i, a := range args {
		switch v := a.(type) {
		case time.Time:
			out[i] = v.UTC().Format(time.RFC3339Nano)
		case []byte:
			// bytea isn't used by upstream — encode as utf-8 string,
			// not base64 (which is what json.Marshal would default to).
			out[i] = string(v)
		default:
			out[i] = v
		}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func readResponse(v js.Value) queryResponse {
	resp := queryResponse{}
	if !v.Truthy() {
		return resp
	}
	cols := v.Get("columns")
	if cols.Truthy() {
		n := cols.Length()
		resp.columns = make([]string, n)
		for i := 0; i < n; i++ {
			resp.columns[i] = cols.Index(i).String()
		}
	}
	types := v.Get("types")
	if types.Truthy() {
		n := types.Length()
		resp.types = make([]int, n)
		for i := 0; i < n; i++ {
			resp.types[i] = types.Index(i).Int()
		}
	}
	rowsV := v.Get("rows")
	if rowsV.Truthy() {
		nrows := rowsV.Length()
		resp.rows = make([][]js.Value, nrows)
		for i := 0; i < nrows; i++ {
			row := rowsV.Index(i)
			ncols := row.Length()
			cells := make([]js.Value, ncols)
			for j := 0; j < ncols; j++ {
				cells[j] = row.Index(j)
			}
			resp.rows[i] = cells
		}
	}
	if a := v.Get("affectedRows"); a.Truthy() {
		resp.affectedRows = int64(a.Int())
	}
	return resp
}

// Postgres OIDs we care about.
const (
	oidBool   = 16
	oidInt8   = 20
	oidInt2   = 21
	oidInt4   = 23
	oidText   = 25
	oidFloat4 = 700
	oidFloat8 = 701
)

func jsToDriverValue(v js.Value, oid int) (driver.Value, error) {
	if v.Type() == js.TypeNull || v.Type() == js.TypeUndefined {
		return nil, nil
	}
	switch oid {
	case oidBool:
		return v.Bool(), nil
	case oidInt2, oidInt4, oidInt8:
		// JS number; safely round-trips up to 2^53.
		return int64(v.Float()), nil
	case oidFloat4, oidFloat8:
		return v.Float(), nil
	}
	// Default: hand back as string. This covers text, varchar, tsvector,
	// user-defined composite/array columns (PGlite returns those as raw
	// Postgres text), and anything else upstream's code happens to scan
	// into a *string. Numeric values that arrive as JS numbers we still
	// stringify so Scan(&s) works.
	switch v.Type() {
	case js.TypeString:
		return v.String(), nil
	case js.TypeNumber:
		f := v.Float()
		// Render like Go would, avoiding scientific notation for small ints.
		if f == float64(int64(f)) {
			return strJoinInt(int64(f)), nil
		}
		return strJoinFloat(f), nil
	case js.TypeBoolean:
		if v.Bool() {
			return "t", nil
		}
		return "f", nil
	case js.TypeObject:
		// Could be a JS array or plain object — JSON-stringify so
		// callers at least see something coherent.
		if jsonStr := js.Global().Get("JSON").Call("stringify", v); jsonStr.Type() == js.TypeString {
			return jsonStr.String(), nil
		}
		return "", errors.New("pglite-js: object value couldn't be stringified")
	}
	return "", fmt.Errorf("pglite-js: unhandled JS type %v", v.Type())
}

func strJoinInt(n int64) string {
	var b strings.Builder
	if n < 0 {
		b.WriteByte('-')
		n = -n
	}
	if n == 0 {
		return "0"
	}
	var digits [20]byte
	i := len(digits)
	for n > 0 {
		i--
		digits[i] = byte('0' + n%10)
		n /= 10
	}
	b.Write(digits[i:])
	return b.String()
}

func strJoinFloat(f float64) string {
	// Use %g for compact representation; the JS Number → Go float64
	// round-trip preserves precision.
	return fmt.Sprintf("%g", f)
}
