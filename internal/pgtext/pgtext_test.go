package pgtext_test

import (
	"reflect"
	"testing"

	"github.com/markburgess/SSTorytime/internal/pgtext"
)

func TestDecodeComposite(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"NodePtr basic", "(1,42)", []string{"1", "42"}},
		{"NodePtr zero", "(0,99)", []string{"0", "99"}},
		{"empty composite", "()", []string{}},
		// Quoted field containing comma + space.
		{"quoted comma+space", `("hello, world",2)`, []string{"hello, world", "2"}},
		// Backslash-escaped quote inside a quoted field: input is `("a\"b",x)`.
		{"escaped quote", `("a\"b",x)`, []string{`a"b`, "x"}},
		// Nested composite as a Link's last field — Postgres always
		// quotes a composite field that contains parens/commas, so it
		// arrives as `"(0,13)"` and DecodeComposite strips the outer
		// quotes giving the literal nested composite.
		{
			"Link with nested NodePtr",
			`(7,0.5,2,"(0,13)")`,
			[]string{"7", "0.5", "2", "(0,13)"},
		},
		// NULL in a composite is represented by an empty unquoted field.
		// Caller needs to know which fields are nullable; we just pass it through.
		{"empty field = NULL", "(,42)", []string{"", "42"}},
		{"trailing empty field", "(1,)", []string{"1", ""}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := pgtext.DecodeComposite(c.in)
			if err != nil {
				t.Fatalf("DecodeComposite(%q) err: %v", c.in, err)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("DecodeComposite(%q)\n got=%#v\nwant=%#v", c.in, got, c.want)
			}
		})
	}
}

func TestDecodeArray(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "{}", nil},
		{"ints", "{1,2,3}", []string{"1", "2", "3"}},
		// Composite-typed array elements are ALWAYS quoted in
		// Postgres's output (because they contain commas + parens).
		// This is the form PGlite returned in the spike for
		// SELECT ARRAY[ROW(...)::NodePtr, ...]:
		{
			"NodePtr[] (Postgres-quoted form)",
			`{"(1,42)","(2,43)"}`,
			[]string{"(1,42)", "(2,43)"},
		},
		{
			"Link[] with quoted nested composite (spike output)",
			`{"(7,0.5,2,\"(0,13)\")","(8,0.7,3,\"(1,14)\")"}`,
			[]string{`(7,0.5,2,"(0,13)")`, `(8,0.7,3,"(1,14)")`},
		},
		{"NULL element passes through as literal", "{NULL,1}", []string{"NULL", "1"}},
		{"quoted comma in element", `{"a,b","c,d"}`, []string{"a,b", "c,d"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := pgtext.DecodeArray(c.in)
			if err != nil {
				t.Fatalf("DecodeArray(%q) err: %v", c.in, err)
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("DecodeArray(%q)\n got=%#v\nwant=%#v", c.in, got, c.want)
			}
		})
	}
}

func TestDecodeErrors(t *testing.T) {
	bad := []struct{ name, in string }{
		{"composite no parens", "1,2"},
		{"composite unbalanced", "(1,2"},
		{"array no braces", "1,2"},
		{"array unbalanced", "{1,2"},
		{"composite unterminated quote", `("a,b)`},
	}
	for _, c := range bad {
		t.Run(c.name, func(t *testing.T) {
			var err error
			switch c.in[0:1] {
			case "(", "1", `"`:
				_, err = pgtext.DecodeComposite(c.in)
			case "{":
				_, err = pgtext.DecodeArray(c.in)
			default:
				_, err = pgtext.DecodeComposite(c.in)
			}
			if err == nil {
				t.Errorf("expected error for %q", c.in)
			}
		})
	}
}

func TestEncodeComposite(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want string
	}{
		{"NodePtr basic", []string{"1", "42"}, "(1,42)"},
		{"empty composite", []string{}, "()"},
		{"field with comma needs quoting", []string{"hello, world", "2"}, `("hello, world",2)`},
		{"field with quote escapes it", []string{`a"b`, "x"}, `("a\"b",x)`},
		// Nested composite as a string inside a Link — the inner value
		// already looks like "(0,13)" and gets quoted because of parens.
		{
			"Link with nested composite",
			[]string{"7", "0.5", "2", "(0,13)"},
			`(7,0.5,2,"(0,13)")`,
		},
		{"empty field stays empty (no quoting needed)", []string{"", "1"}, "(,1)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := pgtext.EncodeComposite(c.in...)
			if got != c.want {
				t.Errorf("EncodeComposite(%#v) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestEncodeArray(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want string
	}{
		{"empty", nil, "{}"},
		{"ints", []string{"1", "2"}, "{1,2}"},
		// When elements are composite literals (contain comma/paren),
		// we quote+escape them as Postgres does.
		{
			"NodePtr[] gets quoted",
			[]string{"(1,42)", "(2,43)"},
			`{"(1,42)","(2,43)"}`,
		},
		// Doubly-nested: Link[] where each Link contains a NodePtr
		// (already pre-encoded with internal quotes for the nested NodePtr).
		{
			"Link[] with nested NodePtr",
			[]string{`(7,0.5,2,"(0,13)")`, `(8,0.7,3,"(1,14)")`},
			`{"(7,0.5,2,\"(0,13)\")","(8,0.7,3,\"(1,14)\")"}`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := pgtext.EncodeArray(c.in...)
			if got != c.want {
				t.Errorf("EncodeArray(%#v)\n got=%q\nwant=%q", c.in, got, c.want)
			}
		})
	}
}

// Round-trip: things we encode should decode back to the same fields.
func TestRoundTripComposite(t *testing.T) {
	inputs := [][]string{
		{"1", "42"},
		{"hello, world", "2"},
		{`a"b`, "x"},
		{"7", "0.5", "2", "(0,13)"},
		{"", "1"},
		{},
	}
	for _, in := range inputs {
		enc := pgtext.EncodeComposite(in...)
		out, err := pgtext.DecodeComposite(enc)
		if err != nil {
			t.Fatalf("decode after encode err: %v (encoded=%q, in=%#v)", err, enc, in)
		}
		want := in
		if len(want) == 0 {
			want = []string{}
		}
		if !reflect.DeepEqual(out, want) {
			t.Errorf("round-trip\n  in=%#v\n  enc=%q\n  out=%#v", in, enc, out)
		}
	}
}

func TestRoundTripArray(t *testing.T) {
	inputs := [][]string{
		{"1", "2", "3"},
		{"(1,42)", "(2,43)"},
		{`(7,0.5,2,"(0,13)")`, `(8,0.7,3,"(1,14)")`},
		{"a,b", "c,d"},
		nil,
	}
	for _, in := range inputs {
		enc := pgtext.EncodeArray(in...)
		out, err := pgtext.DecodeArray(enc)
		if err != nil {
			t.Fatalf("decode after encode err: %v (encoded=%q, in=%#v)", err, enc, in)
		}
		want := in
		if !reflect.DeepEqual(out, want) {
			t.Errorf("round-trip array\n  in=%#v\n  enc=%q\n  out=%#v", in, enc, out)
		}
	}
}
