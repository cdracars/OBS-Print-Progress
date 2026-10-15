/**
 * Unit tests for gcode-toolpath.js and toolpath-demo.js (Live Toolpath overlay)
 * Same style as print-progress.test.js: Arrange-Act-Assert, no framework.
 * Run with: node tests/gcode-toolpath.test.js
 */

const path = require('path');
const {
    ToolpathParser, FEATURES, SEG_FLOATS, SEG_ATTRS,
    classifyFeature, segmentIndexAtOffset, refineIndexByPosition, layerIndexAt, parseGcodeText
} = require(path.join(__dirname, '..', 'gcode-toolpath.js'));
const { generateDemoGcode, clipLines } = require(path.join(__dirname, '..', 'toolpath-demo.js'));

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, message) {
    if (actual !== expected) throw new Error(`${message}\n  expected: ${expected}\n  actual:   ${actual}`);
}

function assertClose(actual, expected, tolerance, message) {
    if (!(Math.abs(actual - expected) <= tolerance)) {
        throw new Error(`${message}\n  expected: ${expected} ±${tolerance}\n  actual:   ${actual}`);
    }
}

function assertTrue(value, message) {
    if (!value) throw new Error(message);
}

function seg(parser, i) {
    return Array.from(parser.positions.subarray(i * SEG_FLOATS, i * SEG_FLOATS + 6)).map(v => Math.round(v * 1000) / 1000);
}

const bytes = text => Uint8Array.from(Buffer.from(text, 'utf8'));

// ============================================================================
// MOVE PARSING
// ============================================================================

function test_extrusion_moves_become_segments_and_travel_is_skipped() {
    console.log('TEST: Extrusion moves become segments, travel and retracts do not');

    // Arrange
    const gcode = [
        'G90', 'M82', 'G92 E0',
        'G0 X10 Y10 Z0.2 F6000',  // travel
        'G1 X20 Y10 E1.0 F1200',  // extrude
        'G1 E0.2',                // retract only
        'G1 X30 Y10',             // travel (no E)
        'G1 E1.0',                // unretract
        'G1 X30 Y20 E2.0'         // extrude
    ].join('\n');

    // Act
    const p = parseGcodeText(gcode);

    // Assert
    assertEqual(p.count, 2, 'Should create exactly two segments');
    assertEqual(seg(p, 0).join(), '10,10,0.2,20,10,0.2', 'First segment endpoints');
    assertEqual(seg(p, 1).join(), '30,10,0.2,30,20,0.2', 'Second segment endpoints');
    assertEqual(p.attrs[1], 10, 'Feedrate 1200 mm/min = 20 mm/s stored as speed/2');
    console.log('✓ PASS\n');
}

function test_relative_extrusion_m83() {
    console.log('TEST: Relative extrusion (M83) treats every positive E as extrusion');

    // Arrange
    const gcode = 'G90\nM83\nG1 X0 Y0 Z0.3\nG1 X5 E0.5\nG1 X10 E0.5\nG1 X15 E-0.8\nG1 X20 E0.5';

    // Act
    const p = parseGcodeText(gcode);

    // Assert
    assertEqual(p.count, 3, 'Retract move (negative E) must not create a segment');
    console.log('✓ PASS\n');
}

function test_g91_makes_coordinates_and_extrusion_relative() {
    console.log('TEST: G91 relative coordinates (Klipper: also makes E relative)');

    // Arrange
    const gcode = 'G90\nM82\nG1 X10 Y10 Z1\nG91\nG1 X5 E1\nG1 Y5 E1\nG90\nG1 X0 Y0 E5';

    // Act
    const p = parseGcodeText(gcode);

    // Assert
    assertEqual(p.count, 3, 'Should create three segments');
    assertEqual(seg(p, 0).join(), '10,10,1,15,10,1', 'First relative move');
    assertEqual(seg(p, 1).join(), '15,10,1,15,15,1', 'Second relative move');
    assertEqual(seg(p, 2).join(), '15,15,1,0,0,1', 'Back to absolute; E5 > accumulated E2 so it extrudes');
    console.log('✓ PASS\n');
}

function test_g92_resets_extruder_position() {
    console.log('TEST: G92 E0 resets the extruder so absolute E keeps working');

    // Arrange
    const gcode = 'M82\nG1 X0 Y0 Z0.2\nG1 X10 E5\nG92 E0\nG1 X20 E1\nG1 X30 E0.5';

    // Act
    const p = parseGcodeText(gcode);

    // Assert
    assertEqual(p.count, 2, 'E1 after reset extrudes, E0.5 (going backwards) does not');
    console.log('✓ PASS\n');
}

function test_line_numbers_checksums_and_inline_comments() {
    console.log('TEST: N line numbers, *checksums and inline comments are handled');

    // Arrange
    const gcode = 'N1 G1 X0 Y0 Z0.2*33\nN2 G1 X10 Y0 E1 ; outer wall\nG1 X10 Y10 E2*99 X999';

    // Act
    const p = parseGcodeText(gcode);

    // Assert
    assertEqual(p.count, 2, 'Should create two segments');
    assertEqual(seg(p, 1).join(), '10,0,0.2,10,10,0.2', 'Words after * must be ignored');
    console.log('✓ PASS\n');
}

function test_klipper_macros_are_ignored() {
    console.log('TEST: Klipper extended commands (GET_POSITION, SET_...) are ignored');

    // Arrange
    const gcode = 'G1 X0 Y0 Z0.2\nGET_POSITION\nEXCLUDE_OBJECT_START NAME=part_1\nG1 X10 E1\nM117 Hello X99';

    // Act
    const p = parseGcodeText(gcode);

    // Assert
    assertEqual(p.count, 1, 'Only the G1 extrusion should count');
    assertEqual(seg(p, 0).join(), '0,0,0.2,10,0,0.2', 'Macro words must not move the head');
    console.log('✓ PASS\n');
}

// ============================================================================
// ARCS
// ============================================================================

function test_arc_g3_quarter_circle() {
    console.log('TEST: G3 counter-clockwise quarter arc is linearized on the circle');

    // Arrange: centre (0,0), radius 10, from (10,0) to (0,10)
    const gcode = 'G1 X10 Y0 Z0.2\nG3 X0 Y10 I-10 J0 E1';

    // Act
    const p = parseGcodeText(gcode, { arcResolution: 0.5 });

    // Assert
    const expectedPieces = Math.ceil((Math.PI / 2 * 10) / 0.5);
    assertEqual(p.count, expectedPieces, 'Arc length / resolution pieces');
    const last = seg(p, p.count - 1);
    assertClose(last[3], 0, 1e-4, 'Arc ends at X0');
    assertClose(last[4], 10, 1e-4, 'Arc ends at Y10');
    for (let i = 0; i < p.count; i++) {
        const s = seg(p, i);
        assertClose(Math.hypot(s[3], s[4]), 10, 0.01, `Piece ${i} stays on the circle`);
        assertTrue(s[3] <= s[0] + 1e-6, 'CCW from (10,0) moves towards -X');
    }
    console.log('✓ PASS\n');
}

function test_arc_g2_full_circle() {
    console.log('TEST: G2 with identical start and end is a full clockwise circle');

    // Arrange
    const gcode = 'G1 X10 Y0 Z0.2\nG2 X10 Y0 I-10 J0 E5';

    // Act
    const p = parseGcodeText(gcode, { arcResolution: 1 });

    // Assert
    assertEqual(p.count, Math.ceil(Math.PI * 2 * 10), 'Full circle pieces');
    assertTrue(seg(p, 0)[4] < 0, 'Clockwise from (10,0) first heads to -Y');
    console.log('✓ PASS\n');
}

// ============================================================================
// FEATURES + LAYERS
// ============================================================================

function test_feature_classification_across_slicers() {
    console.log('TEST: Feature names from PrusaSlicer, Orca/Bambu and Cura are classified');

    // Arrange
    const cases = {
        'External perimeter': 'Outer wall', 'Outer wall': 'Outer wall', 'WALL-OUTER': 'Outer wall',
        'Perimeter': 'Inner wall', 'Inner wall': 'Inner wall', 'WALL-INNER': 'Inner wall',
        'Overhang perimeter': 'Overhang wall',
        'Internal infill': 'Sparse infill', 'Sparse infill': 'Sparse infill', 'FILL': 'Sparse infill',
        'Solid infill': 'Solid infill', 'Internal solid infill': 'Solid infill', 'SKIN': 'Solid infill',
        'Top solid infill': 'Top surface', 'Top surface': 'Top surface',
        'Bottom surface': 'Bottom surface',
        'Bridge infill': 'Bridge', 'Internal Bridge': 'Bridge',
        'Gap fill': 'Gap fill',
        'Support material': 'Support', 'SUPPORT': 'Support',
        'Support material interface': 'Support interface', 'SUPPORT-INTERFACE': 'Support interface',
        'Skirt/Brim': 'Skirt / brim', 'SKIRT': 'Skirt / brim', 'Brim': 'Skirt / brim',
        'Wipe tower': 'Prime tower', 'PRIME-TOWER': 'Prime tower',
        'Ironing': 'Ironing',
        'Custom': 'Other'
    };

    // Act + Assert
    for (const [name, label] of Object.entries(cases)) {
        assertEqual(FEATURES[classifyFeature(name)].label, label, `"${name}"`);
    }
    console.log('✓ PASS\n');
}

function test_type_comments_tag_segments() {
    console.log('TEST: ;TYPE: and ; FEATURE: comments tag the following segments');

    // Arrange
    const gcode = 'G1 X0 Y0 Z0.2\n;TYPE:External perimeter\nG1 X10 E1\n; FEATURE: Sparse infill\nG1 X20 E2';

    // Act
    const p = parseGcodeText(gcode);

    // Assert
    assertEqual(FEATURES[p.attrs[0]].label, 'Outer wall', 'First segment');
    assertEqual(FEATURES[p.attrs[SEG_ATTRS]].label, 'Sparse infill', 'Second segment');
    console.log('✓ PASS\n');
}

function test_layers_from_z_changes_without_comments() {
    console.log('TEST: Without layer comments, Z changes of extrusions start layers (z-hop travel ignored)');

    // Arrange
    const gcode = [
        'G1 X0 Y0 Z0.2', 'G1 X10 E1', 'G1 Z0.6', 'G1 X0', 'G1 Z0.2', 'G1 X0 Y10 E2', // z-hop travel
        'G1 Z0.4', 'G1 X10 E3', 'G1 Z0.6', 'G1 X0 E4'
    ].join('\n');

    // Act
    const p = parseGcodeText(gcode);

    // Assert
    assertEqual(p.layers.length, 3, 'Three distinct extrusion heights');
    assertEqual(p.layers.map(l => l.start).join(), '0,2,3', 'Layer start segments');
    console.log('✓ PASS\n');
}

function test_layer_comments_take_over_and_ignore_purge() {
    console.log('TEST: ;LAYER_CHANGE comments define layers; purge before the first is layer 0');

    // Arrange: purge at Z0.3, then two layers; a spiral-ish Z change inside layer 2
    const gcode = [
        'G1 X0 Y0 Z0.3', 'G1 Y100 E5',
        ';LAYER_CHANGE', 'G1 Z0.2', 'G1 X10 Y10', 'G1 X20 E6',
        ';LAYER_CHANGE', 'G1 Z0.4', 'G1 X10 E7', 'G1 X0 Z0.45 E8'
    ].join('\n');

    // Act
    const p = parseGcodeText(gcode);

    // Assert
    assertEqual(p.layers.length, 2, 'Two slicer layers, purge not counted');
    assertEqual(layerIndexAt(p.layers, 0), -1, 'Purge segment is before the first layer');
    assertEqual(layerIndexAt(p.layers, 3), 1, 'Z drift inside a layer does not add layers');
    console.log('✓ PASS\n');
}

function test_cura_layer_comments() {
    console.log('TEST: Cura ;LAYER:n comments are recognised (but not ;LAYER_COUNT)');

    // Arrange
    const gcode = ';LAYER_COUNT:2\n;LAYER:0\nG1 X0 Y0 Z0.2\nG1 X10 E1\n;LAYER:1\nG1 Z0.4\nG1 X0 E2';

    // Act
    const p = parseGcodeText(gcode);

    // Assert
    assertEqual(p.layers.length, 2, 'Two Cura layers');
    console.log('✓ PASS\n');
}

function test_bounds_ignore_untagged_purge_lines() {
    console.log('TEST: Bounds come from slicer-tagged features, not the start-gcode purge line');

    // Arrange
    const gcode = 'G1 X0 Y0 Z0.3\nG1 Y200 E10\n;TYPE:Outer wall\nG1 X100 Y100 Z0.2\nG1 X120 E11\nG1 Y120 E12';

    // Act
    const b = parseGcodeText(gcode).getBounds();

    // Assert
    assertEqual([b.minX, b.minY, b.maxX, b.maxY].join(), '100,100,120,120', 'Purge line excluded');
    console.log('✓ PASS\n');
}

// ============================================================================
// BYTE OFFSETS (file_position mapping)
// ============================================================================

function test_offsets_are_exact_bytes_with_crlf_and_utf8() {
    console.log('TEST: Segment offsets are exact byte offsets (CRLF + multi-byte UTF-8 comments)');

    // Arrange
    const lines = ['; 温度 220°C', 'G1 X0 Y0 Z0.2', 'G1 X10 E1', '; ünïcödé', 'G1 X20 E2'];
    const text = lines.join('\r\n') + '\r\n';
    const buf = bytes(text);

    // Act
    const p = new ToolpathParser();
    p.push(buf);
    p.finish();

    // Assert
    const endOf = n => Buffer.byteLength(lines.slice(0, n + 1).join('\r\n') + '\r\n', 'utf8');
    assertEqual(p.offsets[0], endOf(2), 'Offset after "G1 X10 E1" line');
    assertEqual(p.offsets[1], endOf(4), 'Offset after the final line');
    assertEqual(p.offsets[1], buf.length, 'Last offset equals file size');
    console.log('✓ PASS\n');
}

function test_chunk_boundaries_do_not_change_results() {
    console.log('TEST: Feeding the file in tiny chunks gives identical results');

    // Arrange
    const text = generateDemoGcode({ height: 3 });
    const buf = bytes(text);
    const whole = new ToolpathParser();
    whole.push(buf); whole.finish();

    // Act
    const chunked = new ToolpathParser();
    for (let i = 0; i < buf.length; i += 7) chunked.push(buf.subarray(i, i + 7));
    chunked.finish();

    // Assert
    assertEqual(chunked.count, whole.count, 'Same number of segments');
    for (let i = 0; i < whole.count; i++) {
        if (chunked.offsets[i] !== whole.offsets[i]) throw new Error(`Offset mismatch at ${i}`);
    }
    for (let i = 0; i < whole.count * SEG_FLOATS; i++) {
        if (chunked.positions[i] !== whole.positions[i]) throw new Error(`Position mismatch at ${i}`);
    }
    assertEqual(chunked.layers.length, whole.layers.length, 'Same layers');
    console.log('✓ PASS\n');
}

function test_file_without_trailing_newline() {
    console.log('TEST: Last line without trailing newline is parsed on finish()');

    // Arrange
    const p = new ToolpathParser();

    // Act
    p.push(bytes('G1 X0 Y0 Z0.2\nG1 X10 E1'));
    const before = p.count;
    p.finish();

    // Assert
    assertEqual(before, 0, 'Incomplete line is held back');
    assertEqual(p.count, 1, 'finish() flushes it');
    console.log('✓ PASS\n');
}

function test_segment_index_at_offset() {
    console.log('TEST: segmentIndexAtOffset counts segments whose line has been read');

    // Arrange
    const offsets = new Float64Array([100, 200, 200, 200, 350]); // arc pieces share an offset

    // Act + Assert
    assertEqual(segmentIndexAtOffset(offsets, 5, 0), 0, 'Nothing read yet');
    assertEqual(segmentIndexAtOffset(offsets, 5, 99), 0, 'Before first line end');
    assertEqual(segmentIndexAtOffset(offsets, 5, 100), 1, 'Exactly at first line end');
    assertEqual(segmentIndexAtOffset(offsets, 5, 250), 4, 'All arc pieces of a read line count');
    assertEqual(segmentIndexAtOffset(offsets, 5, 1e9), 5, 'Past the end');
    console.log('✓ PASS\n');
}

// ============================================================================
// LIVE POSITION REFINEMENT
// ============================================================================

function test_refine_finds_nozzle_segment_behind_lookahead() {
    console.log('TEST: refineIndexByPosition finds the segment the nozzle is on, behind file_position');

    // Arrange: a 10x10 square per layer, two layers
    const sq = z => `G1 Z${z}\nG1 X0 Y0\nG1 X10 Y0 E1\nG1 X10 Y10 E1\nG1 X0 Y10 E1\nG1 X0 Y0 E1`;
    const p = parseGcodeText(`M83\n${sq(0.2)}\n${sq(0.4)}`);

    // Act: file has been read to the end, nozzle is halfway along layer 2's third side
    const r = refineIndexByPosition(p.positions, p.count, p.count, 5, 10, 0.4);

    // Assert
    assertClose(r, 6.5, 1e-6, 'Segment 6 (layer 2, third side) at t=0.5');
    console.log('✓ PASS\n');
}

function test_refine_prefers_current_layer_over_previous() {
    console.log('TEST: refineIndexByPosition picks the current layer, not the identical XY below');

    // Arrange
    const sq = z => `G1 Z${z}\nG1 X0 Y0\nG1 X10 Y0 E1\nG1 X10 Y10 E1\nG1 X0 Y10 E1\nG1 X0 Y0 E1`;
    const p = parseGcodeText(`M83\n${sq(0.2)}\n${sq(0.4)}`);

    // Act: nozzle on first side, at layer-2 height
    const r = refineIndexByPosition(p.positions, p.count, p.count, 3, 0, 0.4);

    // Assert
    assertClose(r, 4.3, 1e-6, 'Layer 2 first side (segment 4), not layer 1 (segment 0)');
    console.log('✓ PASS\n');
}

function test_refine_returns_null_during_travel() {
    console.log('TEST: refineIndexByPosition returns null when the nozzle is far from any extrusion');

    // Arrange
    const p = parseGcodeText('M83\nG1 X0 Y0 Z0.2\nG1 X10 E1');

    // Act
    const r = refineIndexByPosition(p.positions, p.count, p.count, 60, 60, 0.2);

    // Assert
    assertEqual(r, null, 'Travel move far away');
    console.log('✓ PASS\n');
}

// ============================================================================
// DEMO GENERATOR
// ============================================================================

function test_clip_lines_square() {
    console.log('TEST: clipLines fills a square with evenly spaced lines');

    // Arrange
    const square = [[0, 0], [10, 0], [10, 10], [0, 10]];

    // Act
    const lines = clipLines(square, 0, 2);

    // Assert
    assertEqual(lines.length, 5, 'Scan lines at y=0,2,4,6,8 (top edge excluded)');
    lines.forEach(([a, b]) => assertClose(Math.abs(b[0] - a[0]), 10, 1e-9, 'Each line spans the square'));
    console.log('✓ PASS\n');
}

function test_demo_gcode_parses_into_full_model() {
    console.log('TEST: Demo G-code parses into a full multi-feature model');

    // Arrange
    const text = generateDemoGcode();

    // Act
    const p = parseGcodeText(text);
    const b = p.getBounds();

    // Assert
    assertEqual(p.layers.length, 192, '48 mm at 0.25 mm layers');
    assertTrue(p.count > 40000, `Plenty of segments (${p.count})`);
    ['Outer wall', 'Inner wall', 'Sparse infill', 'Solid infill', 'Top surface', 'Bottom surface', 'Skirt / brim'].forEach(label => {
        const id = FEATURES.findIndex(f => f.label === label);
        assertTrue(p.featureCounts[id] > 0, `Demo contains ${label}`);
    });
    assertClose(b.maxZ, 48, 1e-3, 'Model height');
    assertTrue(b.minX > 60 && b.maxX < 160, 'Bounds centred on the bed, purge line excluded');
    assertEqual(p.offsets[p.count - 1] <= Buffer.byteLength(text), true, 'Offsets within file');
    console.log('✓ PASS\n');
}

// ============================================================================
// RUNNER
// ============================================================================

const tests = [
    test_extrusion_moves_become_segments_and_travel_is_skipped,
    test_relative_extrusion_m83,
    test_g91_makes_coordinates_and_extrusion_relative,
    test_g92_resets_extruder_position,
    test_line_numbers_checksums_and_inline_comments,
    test_klipper_macros_are_ignored,
    test_arc_g3_quarter_circle,
    test_arc_g2_full_circle,
    test_feature_classification_across_slicers,
    test_type_comments_tag_segments,
    test_layers_from_z_changes_without_comments,
    test_layer_comments_take_over_and_ignore_purge,
    test_cura_layer_comments,
    test_bounds_ignore_untagged_purge_lines,
    test_offsets_are_exact_bytes_with_crlf_and_utf8,
    test_chunk_boundaries_do_not_change_results,
    test_file_without_trailing_newline,
    test_segment_index_at_offset,
    test_refine_finds_nozzle_segment_behind_lookahead,
    test_refine_prefers_current_layer_over_previous,
    test_refine_returns_null_during_travel,
    test_clip_lines_square,
    test_demo_gcode_parses_into_full_model
];

console.log('='.repeat(60));
console.log('GCODE TOOLPATH TESTS');
console.log('='.repeat(60) + '\n');

for (const test of tests) {
    try {
        test();
        passed++;
    } catch (err) {
        failed++;
        console.log(`✗ FAIL: ${err.message}\n`);
    }
}

console.log('='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
