// Provides a SQL-language `unaccent(text)` function under the WASM
// build, since PGlite doesn't ship the `unaccent` contrib extension.
// Upstream's Configure() does CREATE EXTENSION unaccent (the result
// is silently discarded — fine when it fails on PGlite) and then
// defines sst_unaccent(text) as a plpgsql wrapper around unaccent().
// Installing our shim BEFORE Configure() runs means sst_unaccent's
// body resolves unaccent() to our shim, so the Node.UnSearch
// generated column works.
//
// Implementation: NFD-decompose, then regex-strip everything in the
// Combining Diacritical Marks block (U+0300..U+036F). That handles
// almost all Western diacritics in one pass and preserves CJK and
// other non-Latin scripts unchanged. A small translate() pass mops
// up the dozen "letters with built-in strokes" (ø Ø ł Ł đ Đ ß æ œ
// þ ð and friends) that don't decompose under NFD.
//
// Verified against PGlite 0.4.4 — see commit notes for the spike.

//go:build js && wasm

package SSTorytime

import (
	"fmt"
	"strings"
)

// Letters that don't decompose under NFD (no base + combining mark
// pair). 1:1 substitution since these are all single Latin folds.
const nonDecomposingFrom = "øØłŁđĐřŘťŤßæœÆŒþÞðÐ"
const nonDecomposingTo = "oOlLdDrRtTsaoAOtTdD"

// InstallUnaccent registers an unaccent(text) SQL function on the
// open connection. Called from the WASM Open path BEFORE Configure().
func InstallUnaccent(sst PoSST) error {
	if runesLen(nonDecomposingFrom) != runesLen(nonDecomposingTo) {
		// Build-time bug; refuse to install rather than corrupt data.
		return fmt.Errorf("unaccent shim: from/to length mismatch (%d vs %d)",
			runesLen(nonDecomposingFrom), runesLen(nonDecomposingTo))
	}
	cm := combiningMarksBlock()
	q := fmt.Sprintf(
		`CREATE OR REPLACE FUNCTION unaccent(text) RETURNS text
		 LANGUAGE SQL IMMUTABLE AS $fn$
		   SELECT translate(
		     regexp_replace(normalize($1, NFD), '[' || %s || ']', '', 'g'),
		     %s, %s
		   );
		 $fn$;`,
		quoteSQLLiteral(cm),
		quoteSQLLiteral(nonDecomposingFrom),
		quoteSQLLiteral(nonDecomposingTo),
	)
	if _, err := sst.DB.Query(q); err != nil {
		return fmt.Errorf("install unaccent shim: %w", err)
	}
	return nil
}

// combiningMarksBlock returns U+0300..U+036F as a literal string —
// the Combining Diacritical Marks Unicode block, which covers the
// marks NFD decomposition produces for accented Latin letters.
func combiningMarksBlock() string {
	var b strings.Builder
	for cp := rune(0x0300); cp <= 0x036F; cp++ {
		b.WriteRune(cp)
	}
	return b.String()
}

func runesLen(s string) int {
	n := 0
	for range s {
		n++
	}
	return n
}

// quoteSQLLiteral renders a Go string as a Postgres E'…' escape-string
// literal so the combining marks survive without depending on the
// session's standard_conforming_strings setting.
func quoteSQLLiteral(s string) string {
	var b strings.Builder
	b.WriteString("E'")
	for _, r := range s {
		switch r {
		case '\'':
			b.WriteString(`\'`)
		case '\\':
			b.WriteString(`\\`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('\'')
	return b.String()
}
