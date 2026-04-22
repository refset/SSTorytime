// Package pgtext decodes and encodes Postgres text-format composite
// literals "(f1,f2,...)" and array literals "{e1,e2,...}".
//
// PGlite (the in-browser Postgres) returns user-defined composite and
// array values to the JS host as their raw Postgres text representation
// rather than as decoded JS structures, so when we bridge those values
// back into Go through database/sql we need to parse them ourselves.
//
// Scope is intentionally narrow: split a literal into its top-level
// fields/elements with the right quoting/escaping rules. Type-aware
// decoding (e.g. parsing a field as int) is the caller's job.
package pgtext

import (
	"errors"
	"strings"
)

// DecodeComposite parses a Postgres composite literal "(f1,f2,...)"
// and returns the unquoted top-level field strings.
//
// A NULL field is the empty unquoted string between commas; we pass
// "" through and leave it to the caller (who knows the column types)
// to distinguish NULL from the empty string.
func DecodeComposite(s string) ([]string, error) {
	if len(s) < 2 || s[0] != '(' || s[len(s)-1] != ')' {
		return nil, errors.New("pgtext: composite literal not enclosed in parens: " + s)
	}
	inner := s[1 : len(s)-1]
	if inner == "" {
		return []string{}, nil
	}
	return splitFields(inner)
}

// DecodeArray parses a Postgres array literal "{e1,e2,...}" and
// returns the unquoted top-level element strings. The literal "NULL"
// (case-sensitive in the wire format) is passed through as the
// string "NULL"; callers that care about NULL elements should check
// for it before further decoding.
func DecodeArray(s string) ([]string, error) {
	if len(s) < 2 || s[0] != '{' || s[len(s)-1] != '}' {
		return nil, errors.New("pgtext: array literal not enclosed in braces: " + s)
	}
	inner := s[1 : len(s)-1]
	if inner == "" {
		return nil, nil
	}
	return splitFields(inner)
}

// splitFields splits a comma-separated list, respecting double-quoted
// runs and \-escapes inside them. It does NOT track parenthesis or
// brace nesting outside quotes — Postgres always quotes composite
// fields and array elements that themselves contain commas/parens/
// braces, so any unquoted comma at this level is a real separator.
// (If you handcraft a literal that breaks this assumption, Postgres
// itself would re-quote it on output, so round-tripping still works.)
func splitFields(s string) ([]string, error) {
	out := []string{}
	var cur strings.Builder
	inQuotes := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !inQuotes {
			switch c {
			case ',':
				out = append(out, cur.String())
				cur.Reset()
			case '"':
				inQuotes = true
			default:
				cur.WriteByte(c)
			}
			continue
		}
		// Inside a quoted run.
		switch c {
		case '\\':
			if i+1 >= len(s) {
				return nil, errors.New("pgtext: dangling backslash in quoted field")
			}
			cur.WriteByte(s[i+1])
			i++
		case '"':
			inQuotes = false
		default:
			cur.WriteByte(c)
		}
	}
	if inQuotes {
		return nil, errors.New("pgtext: unterminated quoted field")
	}
	out = append(out, cur.String())
	return out, nil
}

// EncodeComposite renders fields as a Postgres composite literal.
// Fields are quoted only when needed (commas, parens, double quotes,
// backslashes, leading/trailing whitespace). Empty unquoted fields
// represent NULL — pass "" if you want a NULL field.
func EncodeComposite(fields ...string) string {
	var b strings.Builder
	b.WriteByte('(')
	for i, f := range fields {
		if i > 0 {
			b.WriteByte(',')
		}
		writeQuoted(&b, f, compositeNeedsQuoting)
	}
	b.WriteByte(')')
	return b.String()
}

// EncodeArray renders elements as a Postgres array literal.
// Elements are quoted only when needed (commas, braces, double quotes,
// backslashes, leading/trailing whitespace). Empty arrays render "{}".
func EncodeArray(elements ...string) string {
	var b strings.Builder
	b.WriteByte('{')
	for i, e := range elements {
		if i > 0 {
			b.WriteByte(',')
		}
		writeQuoted(&b, e, arrayNeedsQuoting)
	}
	b.WriteByte('}')
	return b.String()
}

func compositeNeedsQuoting(s string) bool {
	if s == "" {
		// Empty represents NULL in composite syntax — we deliberately
		// don't quote it (a quoted "" would be the empty string, not NULL).
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == ',' || c == '(' || c == ')' || c == '"' || c == '\\' {
			return true
		}
	}
	if s[0] == ' ' || s[len(s)-1] == ' ' {
		return true
	}
	return false
}

func arrayNeedsQuoting(s string) bool {
	if s == "" {
		// Empty in an array isn't a real value — we still quote it so
		// it isn't mistaken for NULL.
		return true
	}
	if strings.EqualFold(s, "NULL") {
		// Without quoting, "NULL" would be parsed as the SQL NULL.
		return true
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == ',' || c == '{' || c == '}' || c == '"' || c == '\\' {
			return true
		}
	}
	if s[0] == ' ' || s[len(s)-1] == ' ' {
		return true
	}
	return false
}

func writeQuoted(b *strings.Builder, s string, needs func(string) bool) {
	if !needs(s) {
		b.WriteString(s)
		return
	}
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' || c == '\\' {
			b.WriteByte('\\')
		}
		b.WriteByte(c)
	}
	b.WriteByte('"')
}
