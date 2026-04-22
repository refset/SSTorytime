//**************************************************************
//
// db_upload.go
//
//**************************************************************

package SSTorytime

import (
        "fmt"
	"strings"
	_ "github.com/lib/pq"

)

//**************************************************************

func GraphToDB(sst PoSST,wait_counter bool) {

	total := len(sst.NODE_DIRECTORY.N1directory) + len(sst.NODE_DIRECTORY.N2directory) + len(sst.NODE_DIRECTORY.N3directory) + len(sst.NODE_DIRECTORY.LT128) + len(sst.NODE_DIRECTORY.LT1024) + len(sst.NODE_DIRECTORY.GT1024) + len(sst.PAGE_MAP)

	fmt.Println("\nStoring primary nodes ...\n")

	for class := N1GRAM; class <= GT1024; class++ {

		offset := int(sst.BASE_DB_CHANNEL_STATE[class])

		switch class {
		case N1GRAM:
			uploadNodesBatch(&sst, sst.NODE_DIRECTORY.N1directory[offset:])
		case N2GRAM:
			uploadNodesBatch(&sst, sst.NODE_DIRECTORY.N2directory[offset:])
		case N3GRAM:
			uploadNodesBatch(&sst, sst.NODE_DIRECTORY.N3directory[offset:])
		case LT128:
			uploadNodesBatch(&sst, sst.NODE_DIRECTORY.LT128[offset:])
		case LT1024:
			uploadNodesBatch(&sst, sst.NODE_DIRECTORY.LT1024[offset:])
		case GT1024:
			uploadNodesBatch(&sst, sst.NODE_DIRECTORY.GT1024[offset:])
		}
		_ = total
		_ = wait_counter
	}

	// Arrows etc

	fmt.Println("\nStoring Arrows...")

	sst.DB.QueryRow("drop table ArrowDirectory")
	sst.DB.QueryRow("drop table ArrowInverses")

	if !CreateTable(sst,ARROW_INVERSES_TABLE) {
		fmt.Println("Unable to create table as, ",ARROW_INVERSES_TABLE)
		panic("SSTorytime: fatal error")
	}
	if !CreateTable(sst,ARROW_DIRECTORY_TABLE) {
		fmt.Println("Unable to create table as, ",ARROW_DIRECTORY_TABLE)
		panic("SSTorytime: fatal error")
	}

	UploadAllArrowsToDB(sst)

	fmt.Println("Storing inverse Arrows...")

	UploadAllInverseArrowsToDB(sst)

	fmt.Println("Storing contexts...")

	UploadContextsToDB(&sst)

	fmt.Println("Storing page map...")

	uploadPageMapBatch(sst, sst.PAGE_MAP)

	// CREATE INDICES

	fmt.Println("Indexing ....")

//	sst.DB.QueryRow("CREATE INDEX IF NOT EXISTS sst_type on Node (((NPtr).Chan),L,S)")
	sst.DB.QueryRow("CREATE INDEX IF NOT EXISTS sst_gin on Node USING GIN (to_tsvector('english',Search))")
	sst.DB.QueryRow("CREATE INDEX IF NOT EXISTS sst_ungin on Node USING GIN (to_tsvector('english',UnSearch))")
	sst.DB.QueryRow("CREATE INDEX IF NOT EXISTS sst_s on Node USING GIN (S)")
	sst.DB.QueryRow("CREATE INDEX IF NOT EXISTS sst_n on Node USING GIN (NPtr)")
	sst.DB.QueryRow("CREATE INDEX IF NOT EXISTS sst_cnt on ContextDirectory USING GIN (Context)")
	sst.DB.QueryRow("ALTER TABLE Node SET LOGGED")
	sst.DB.QueryRow("ALTER TABLE PageMap SET LOGGED")

	fmt.Println("Finally done!")
}

// **************************************************************************
//  Uploading memory cache to database
// **************************************************************************

func UploadNodeToDB(sst *PoSST, org Node) {

	qstr := "BEGIN;\n" + nodeUploadBody(sst, org) + "COMMIT;"

	row,err := sst.DB.Query(qstr)

	if err != nil {
		s := fmt.Sprint("Failed to insert",err)

		if strings.Contains(s,"duplicate key") {
		} else {
			fmt.Println(s,"FAILED \n",qstr,err)
		}
		return
	}

	row.Close()
}

// nodeUploadBody returns the INSERT/UPDATE block for a single node
// *without* the wrapping BEGIN/COMMIT so callers can pack many into
// one transaction.
func nodeUploadBody(sst *PoSST, org Node) string {
	body := FormDBNode(sst, org)
	for stindex := 0; stindex < len(org.I); stindex++ {
		lnkarray := FormatSQLLinkArray(org.I[stindex])
		sttype := STIndexToSTType(stindex)
		body += AppendDBLinkArrayToNode(sst, org.NPtr, lnkarray, sttype)
	}
	body += "\n"
	return body
}

// uploadNodesBatch wraps up to chunkSize node bodies into one
// BEGIN…COMMIT. Collapses N round-trips to ceil(N/chunkSize) at the
// cost of longer SQL strings.
func uploadNodesBatch(sst *PoSST, nodes []Node) {
	// 50 nodes per round-trip is the sweet spot in practice. PGlite's
	// SQL parser/planner is roughly super-linear in statement-count
	// per batch — larger chunks (tried 200) send individual batch
	// execution past 15 s on medium files. 50 keeps each batch under
	// ~50KB of SQL so the executor stays in its fast path.
	const chunkSize = 50
	for i := 0; i < len(nodes); i += chunkSize {
		end := i + chunkSize
		if end > len(nodes) {
			end = len(nodes)
		}
		var b strings.Builder
		b.WriteString("BEGIN;\n")
		for j := i; j < end; j++ {
			b.WriteString(nodeUploadBody(sst, nodes[j]))
		}
		b.WriteString("COMMIT;")
		row, err := sst.DB.Query(b.String())
		if err != nil {
			s := fmt.Sprint("Failed to insert node batch", err)
			if !strings.Contains(s, "duplicate key") {
				fmt.Println(s, "FAILED batch of", end-i)
			}
			continue
		}
		row.Close()
	}
}

// pageMapBody mirrors UploadPageMapEvent without BEGIN/COMMIT.
func pageMapBody(line PageMap) string {
	chap := SQLEscape(line.Chapter)
	lnkarray := FormatSQLLinkArray(line.Path)
	return fmt.Sprintf("INSERT INTO PageMap (Chap,Alias,Ctx,Line) VALUES ('%s','%s',%d,%d);\n"+
		"UPDATE PageMap SET Path='%s' WHERE Chap = '%s' AND Line = '%d';\n",
		chap, line.Alias, line.Context, line.Line, lnkarray, chap, line.Line)
}

func uploadPageMapBatch(sst PoSST, lines []PageMap) {
	const chunkSize = 200
	for i := 0; i < len(lines); i += chunkSize {
		end := i + chunkSize
		if end > len(lines) {
			end = len(lines)
		}
		var b strings.Builder
		b.WriteString("BEGIN;\n")
		for j := i; j < end; j++ {
			b.WriteString(pageMapBody(lines[j]))
		}
		b.WriteString("COMMIT;")
		row, err := sst.DB.Query(b.String())
		if err != nil {
			s := fmt.Sprint("Failed to insert pagemap batch", err)
			if !strings.Contains(s, "duplicate key") {
				fmt.Println(s, "FAILED batch of", end-i)
			}
			continue
		}
		row.Close()
	}
}

// **************************************************************************

// UploadAllArrowsToDB batches every arrow insert into one multi-
// statement query. Much cheaper than one round-trip per arrow when
// the driver is a Promise-bridged embedded PGlite (the WASM build),
// and strictly faster on native Postgres too.
func UploadAllArrowsToDB(sst PoSST) {
	if len(sst.ARROW_DIRECTORY) == 0 {
		return
	}
	var b strings.Builder
	b.WriteString("BEGIN;\n")
	for arrow := range sst.ARROW_DIRECTORY {
		a := ArrowPtr(arrow)
		staidx := sst.ARROW_DIRECTORY[a].STAindex
		long := SQLEscape(sst.ARROW_DIRECTORY[a].Long)
		short := SQLEscape(sst.ARROW_DIRECTORY[a].Short)
		fmt.Fprintf(&b, "INSERT INTO ArrowDirectory (STAindex,Long,Short,ArrPtr) SELECT %d,'%s','%s',%d WHERE NOT EXISTS (SELECT Long,Short,ArrPtr FROM ArrowDirectory WHERE lower(Long) = lower('%s') OR lower(Short) = lower('%s') OR ArrPtr = %d);\n",
			staidx, long, short, a, long, short, a)
	}
	b.WriteString("COMMIT;")
	if _, err := sst.DB.Query(b.String()); err != nil {
		fmt.Println("UploadAllArrowsToDB failed:", err)
	}
}

func UploadAllInverseArrowsToDB(sst PoSST) {
	if len(sst.INVERSE_ARROWS) == 0 {
		return
	}
	var b strings.Builder
	b.WriteString("BEGIN;\n")
	for arrow := range sst.INVERSE_ARROWS {
		plus := ArrowPtr(arrow)
		minus := sst.INVERSE_ARROWS[plus]
		fmt.Fprintf(&b, "INSERT INTO ArrowInverses (Plus,Minus) SELECT %d,%d WHERE NOT EXISTS (SELECT Plus,Minus FROM ArrowInverses WHERE Plus = %d OR minus = %d);\n",
			plus, minus, plus, minus)
	}
	b.WriteString("COMMIT;")
	if _, err := sst.DB.Query(b.String()); err != nil {
		fmt.Println("UploadAllInverseArrowsToDB failed:", err)
	}
}

func UploadArrowToDB(sst PoSST,arrow ArrowPtr) {

	staidx := sst.ARROW_DIRECTORY[arrow].STAindex
	long := SQLEscape(sst.ARROW_DIRECTORY[arrow].Long)
	short := SQLEscape(sst.ARROW_DIRECTORY[arrow].Short)

	qstr := fmt.Sprintf("INSERT INTO ArrowDirectory (STAindex,Long,Short,ArrPtr) SELECT %d,'%s','%s',%d WHERE NOT EXISTS (SELECT Long,Short,ArrPtr FROM ArrowDirectory WHERE lower(Long) = lower('%s') OR lower(Short) = lower('%s') OR ArrPtr = %d)",staidx,long,short,arrow,long,short,arrow)

	row,err := sst.DB.Query(qstr)
	
	if err != nil {
		s := fmt.Sprint("Failed to insert",err)
		
		if strings.Contains(s,"duplicate key") {
		} else {
			fmt.Println(s,"FAILED \n",qstr,err)
		}
		return
	}

	row.Close()
}

// **************************************************************************

func UploadInverseArrowToDB(sst PoSST,arrow ArrowPtr) {

	plus := arrow
	minus := sst.INVERSE_ARROWS[arrow]

	qstr := fmt.Sprintf("INSERT INTO ArrowInverses (Plus,Minus) SELECT %d,%d WHERE NOT EXISTS (SELECT Plus,Minus FROM ArrowInverses WHERE Plus = %d OR minus = %d)",plus,minus,plus,minus)

	row,err := sst.DB.Query(qstr)
	
	if err != nil {
		s := fmt.Sprint("Failed to insert",err)
		
		if strings.Contains(s,"duplicate key") {
		} else {
			fmt.Println(s,"FAILED \n",qstr,err)
		}
		return
	}
	row.Close()
}

// **************************************************************************

func UploadContextsToDB(sst *PoSST) {

	for ctxdir := range sst.CONTEXT_DIRECTORY {
		UploadContextToDB(sst,sst.CONTEXT_DIRECTORY[ctxdir].Context,sst.CONTEXT_DIRECTORY[ctxdir].Ptr)
	}
}

// **************************************************************************

func UploadContextToDB(sst *PoSST,contextstring string,ptr ContextPtr) ContextPtr {

	a := SQLEscape(contextstring)
	b := ptr

	// Make sure neither a nor b are previously defined

	qstr := fmt.Sprintf("SELECT IdempInsertContext('%s',%d)",a,b)

	row,err := sst.DB.Query(qstr)
	
	if err != nil {
		fmt.Println("FAILED \n",qstr,err)
	}

	var cptr ContextPtr

	if row != nil {
		for row.Next() {
			err = row.Scan(&cptr)
		}
		row.Close()
	}

	return cptr
}

//**************************************************************

func UploadPageMapEvent(sst PoSST, line PageMap) {

	chap := SQLEscape(line.Chapter)

	qstr := "BEGIN;\n"

	qstr += fmt.Sprintf("INSERT INTO PageMap (Chap,Alias,Ctx,Line) VALUES ('%s','%s',%d,%d);\n",chap,line.Alias,line.Context,line.Line)

	lnkarray := FormatSQLLinkArray(line.Path)

	qstr += fmt.Sprintf("\nUPDATE PageMap SET Path='%s' WHERE Chap = '%s' AND Line = '%d';",lnkarray,chap,line.Line)

	qstr += "COMMIT;"

	row,err := sst.DB.Query(qstr)

	if err != nil {
		s := fmt.Sprint("Failed to insert pagemap event",err)

		if strings.Contains(s,"duplicate key") {
		} else {
			fmt.Println(s,"FAILED \n",qstr,err)
		}
		// row is nil on error — no Close() call here (prior code
		// deref'd nil and crashed the runtime under PGlite).
		return
	}

	row.Close()
}


//
// db_upload.go
//


