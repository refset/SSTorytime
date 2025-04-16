module main

go 1.24.2

replace SSTorytime => ../pkg/SSTorytime

require (
	SSTorytime v0.0.0-00010101000000-000000000000
	github.com/lib/pq v1.10.9
	golang.org/x/text v0.24.0
)
