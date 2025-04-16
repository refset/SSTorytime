
all: src/N4L.go test
	(cd src; make)
	(cd src/demo_pocs; make)
	$(MAKE) print-path

test: src/N4L
	(cd src; make)
	(cd src/demo_pocs; make)
	(cd tests; make)
clean:
	rm -f *~ N4L
	(cd src; make clean)
	(cd examples; make clean)
	(cd src/demo_pocs; make clean)

% : %.go
	go build $<

print-path:
	@echo ""
	@echo "✅ Build complete."
	@echo ""
	@echo "👉 To run your binaries without typing './binaryname', add this to your shell:"
	@echo ""
	@echo "    export PATH=\"\$$PATH:$(shell pwd)\""
	@echo ""
	@echo "📌 Tip: add that line to ~/.bashrc or ~/.zshrc to make it permanent."
