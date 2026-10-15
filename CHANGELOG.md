# Changelog

All notable changes to OBS Print Progress will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bambu Lab, Elegoo Centauri Carbon and Snapmaker U1 support** via the new `server.py` bridge (Python standard library only)
  - Bambu Lab: status over MQTT/TLS (P1/A1 delta reports merged), print file over implicit FTPS with the plate G-code extracted from the .3mf (adds the plate thumbnail), P1/A1 port-6000 camera re-served as MJPEG. X1/P2S/H2 cameras: RTSPS URL for an OBS Media Source
  - Elegoo Centauri Carbon (CC1): SDCP v3 over WebSocket, UDP mainboard discovery, MJPEG camera, G-code download
  - Snapmaker U1: Moonraker on port 7125
  - Non-Klipper printers appear to the overlays as a Moonraker-compatible API, so `printer.html` and `toolpath.html` work unchanged
- **Setup page** (`http://localhost:8000`): add printers without editing JSON, network discovery (Bambu SSDP, Elegoo UDP, common Klipper hostnames), connection test with clear error messages, copy-ready OBS URLs
- Klipper printers are proxied through the server (HTTP and websocket), so Moonraker CORS setup is no longer needed
- Live Toolpath follows printers that only report the current layer (Bambu Lab, Elegoo)
- `tests/test_bridge.py` (36 tests) and `tests/fake_printers.py` simulated printers
- **Live Toolpath overlay** (`toolpath.html`): a real-time 3D twin of the current print, rendered with WebGL2
  - Streams the printing G-code from Moonraker and parses it as it downloads (byte-level parser, ~25 MB/s, arcs supported)
  - Printed part drawn as shaded beads, a glowing hot trail behind the nozzle, and a holographic ghost of what's left to print
  - Live sync via a Moonraker websocket subscription (HTTP polling fallback). `file_position` is mapped to segments and refined with `motion_report.live_position` to compensate for Klipper lookahead
  - Colour modes: height gradient (theme colours), slicer feature type, feedrate heatmap
  - Replay animation on print completion, pulsing state while paused
  - `?demo=1` simulated print for trying it out and styling scenes without a printer
- `tests/gcode-toolpath.test.js` - 23 AAA tests for the toolpath parser, live-position sync and demo generator

### Changed

- Start scripts now launch `server.py` and open the setup page. `linux-max-server-start.sh` was renamed to `linux-mac-server-start.sh`, the name the README already used
- `printers.json` gains optional `type`, `serial`, `accessCode`, `model` and `direct` fields; existing files keep working (default type is Klipper)

## [1.4.0] - 2025-12-05

### Added

- **Comprehensive Test Suite** - 28 TDD/AAA tests covering all critical functionality
  - 4 progress calculation tests
  - 2 layer calculation tests
  - 3 time parsing tests
  - 4 time calculation tests
  - 3 layer formatting tests
  - 3 metadata parsing tests
  - 2 percentage calculation tests
  - 2 null safety tests
  - 5 filename handling tests
- Test infrastructure in `tests/` folder with `print-progress.test.js`
- TESTING.md documentation with TDD best practices and usage guide
- Tests validate progress, layer counts, time parsing, metadata extraction, and null handling

### Changed

- **BREAKING FIX: Progress calculation** - Now uses `virtualSdcard.progress` directly instead of calculating from `file_position/file_size`
  - Matches Mainsail's display exactly
  - Accounts for buffering, compression, and lookahead planning
  - Prevents progress discrepancies (e.g., overlay showing 54% when Mainsail shows 96%)
- **Simplified filename handling** - Removed unnecessary path manipulation
  - No longer adds/strips `gcodes/` prefix or tries multiple path variations
  - Uses Klipper's `print_stats.filename` directly as provided
  - Trusts Moonraker's file path structure
- Enhanced time parsing regex to support day format (`1d1h42m` now correctly parses as 25.7 hours)
- Improved layer height extraction with better regex patterns
- README updated with Development & Testing section

### Fixed

- Progress percentage now matches Mainsail exactly (was off by up to 40% in some cases)
- Filename paths no longer manipulated incorrectly, respecting custom configurations
- Time parsing for multi-day prints (e.g., `1d1h42m` previously parsed as just `1h42m`)
- Layer count calculation now attempts common layer heights (0.2mm, 0.15mm, 0.3mm) as fallback
- DEBUG variable hoisting issue that prevented debug logging from working correctly

### Security

- All tests pass before commits to prevent regressions
- Filename handling validated to prevent path manipulation vulnerabilities

## [1.3.0] - 2025-12-04

### Added

- Camera feed retry logic with exponential backoff (3 attempts: 1s, 2s, 4s)
- API connection retry logic with exponential backoff (5 attempts: 2s, 4s, 8s, 16s, 30s)
- Configuration validation for printers.json with helpful error messages
- Comprehensive JSDoc documentation for all major functions
- Detailed field descriptions in printers.json.example with usage examples
- Quick Start guide in README for new users
- Enhanced troubleshooting documentation in README with 6 major scenarios
- Query parameter documentation with examples
- CHANGELOG.md to track project changes
- LICENSE file (MIT)

### Changed

- Improved theme-custom.css.example with 6 professional color themes (Blue, Purple, Green, Orange, Red, Cyan)
- Enhanced error messages with specific categorization (Unreachable, Authentication Error, API Not Found)
- Better configuration validation with duplicate ID detection
- Replaced personal printer names with generic examples (printer1, printer2) throughout documentation
- Improved README structure with proper markdown formatting and blank lines
- Updated documentation to match actual theme files
- Camera setup now includes automatic retry mechanism

### Fixed

- Markdown linting issues in README and CHANGELOG
- Removed duplicate sections in README
- Corrected theme documentation references

## [1.2.0] - 2025-12-04

### Added

- Comprehensive JSDoc-style code documentation throughout
- Filename-based metadata extraction for layer height (e.g., `_0.2_` patterns)
- Filename-based estimated time parsing (e.g., `1h46m`, `2h30m`)
- Detailed debug logging for configuration and metadata loading
- Enhanced G-code metadata parsing with additional pattern recognition
- Automatic layer_count calculation from object_height when layer_height is known

### Changed

- Documented all major functions and their purposes
- Clarified fallback strategies for metadata loading
- Improved regex patterns to match more filename conventions
- Enhanced debug output with comprehensive state information

### Fixed

- parseBool hoisting issue resolved
- Cache buster added to JS script tag for proper updates

## [1.1.0] - 2025-11-XX

### Added

- Theme system with CSS variables for easy color customization
- Three example themes: blue (default), green, and red
- Automatic `theme-custom.css` loading (git-ignored for safe updates)
- Thumbnail glow effect with customizable colors
- Loading state for thumbnail preview with soft glow
- Chamber temperature auto-detection from multiple sensor name patterns
- **Floating G-code thumbnail preview with dynamic positioning** (Thanks to [@CHA3dPrinting](https://github.com/CHA3dPrinting)!)
- **G-code thumbnail extraction from embedded base64 images** (Thanks to [@CHA3dPrinting](https://github.com/CHA3dPrinting)!)
- Inner glow effect on thumbnails

### Changed

- Optimized metadata fetching to reduce 404 errors (single attempt vs 5)
- Reduced thumbnail fetch size from 250KB to 100KB for faster loading
- Non-blocking chamber detection for improved startup performance
- Silenced metadata 404 warnings (auto-retry on next cycle)
- Slicer time now displays even when paused/idle
- Elapsed time shows correctly when paused

### Fixed

- Camera URL now properly auto-generates from JSON config IP
- JSON loading properly merged with thumbnail support
- Broken image icons hidden until successful load
- Camera feed hidden until successfully loaded
- Thumbnail hidden until valid data ready

## [1.0.0] - 2025-XX-XX

### Added

- Initial release with core functionality
- Multi-printer support via `printers.json` configuration
- Real-time print progress tracking from Klipper/Moonraker
- Progress bar with percentage display
- Layer information (current/total)
- Temperature monitoring (hotend, bed, optional chamber)
- Time estimates (progress-based, slicer, elapsed)
- Live camera feed with flip options (horizontal/vertical)
- Query parameter printer selection (`?printer=<id>`)
- Inline configuration fallback
- Debug mode for troubleshooting
- Start scripts for Windows and macOS/Linux
- Comprehensive README documentation

### Features

- Automatic metadata extraction from G-code files
- Fallback layer/time calculations
- Theme system with CSS variables
- Responsive overlay design
- CORS-compatible configuration loading
- Support for file:// and http:// contexts

[Unreleased]: https://github.com/cdracars/OBS-Print-Progress/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/cdracars/OBS-Print-Progress/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/cdracars/OBS-Print-Progress/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/cdracars/OBS-Print-Progress/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/cdracars/OBS-Print-Progress/releases/tag/v1.0.0
