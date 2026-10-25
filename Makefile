UUID = dockcat@MoriartyPuth.github.io
ZIP  = $(UUID).shell-extension.zip

.PHONY: all pack install clean

all: pack

pack:
	gnome-extensions pack --force \
		--extra-source=lib \
		--extra-source=resources \
		--extra-source=LICENSE \
		--extra-source=CREDITS.md \
		--out-dir=.
	@echo "Built $(ZIP)"

install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Installed. Log out and back in, then enable Dockcat."

clean:
	rm -f $(ZIP)
