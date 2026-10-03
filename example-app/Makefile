# Run inside the desktop-uat image (the top-level Makefile does this):
#   test   the logic, compiled natively and run
#   dist   UatDemo.exe cross-compiled with MinGW-w64, zipped for install_build
VERSION  := $(shell cat VERSION)
CXXFLAGS := -std=c++17 -O2 -Wall -Wextra -Werror
BUILD    := build
DIST     := ../dist
ZIP      := $(DIST)/uat-demo-$(VERSION).zip

MINGW    := x86_64-w64-mingw32-g++-posix
WINDRES  := x86_64-w64-mingw32-windres
# Static, so the zip is the whole app: no MinGW runtime DLLs on the desktop.
WINLIBS  := -static -lcomctl32 -lole32 -loleacc -luuid -lshell32

.PHONY: test dist clean

$(BUILD)/test_core: src/core.cpp src/core.hpp tests/test_core.cpp
	@mkdir -p $(BUILD)
	g++ $(CXXFLAGS) -Isrc -o $@ src/core.cpp tests/test_core.cpp

test: $(BUILD)/test_core
	./$(BUILD)/test_core

$(BUILD)/app.res.o: src/app.rc src/app.manifest VERSION
	@mkdir -p $(BUILD)
	$(WINDRES) -I src -DUATDEMO_VERSION_STR='\"$(VERSION)\"' \
		-DUATDEMO_VERSION_NUM=$(subst .,$(comma),$(VERSION)),0 -i src/app.rc -o $@

$(BUILD)/UatDemo.exe: src/core.cpp src/core.hpp src/main.cpp $(BUILD)/app.res.o VERSION
	$(MINGW) $(CXXFLAGS) -municode -mwindows -DUATDEMO_VERSION='"$(VERSION)"' -Isrc \
		-o $@ src/core.cpp src/main.cpp $(BUILD)/app.res.o $(WINLIBS)

dist: $(BUILD)/UatDemo.exe
	@mkdir -p $(DIST)
	rm -f $(ZIP)
	zip -qj $(ZIP) $(BUILD)/UatDemo.exe
	@echo $(ZIP)

clean:
	rm -rf $(BUILD)

comma := ,
