import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MESSAGE_START_MARKER } from "../src/message-marker.ts";
import { ProcessTerminal, type Terminal } from "../src/terminal.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";

const ITERM_MARK = "\x1b]1337;SetMark\x07";
const MAX_WRITE_CHARS = 1024 * 1024;

class RecordingTerminal implements Terminal {
	writes: string[] = [];
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	messageMark = "";
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class Messages implements Component {
	lines = [`${MESSAGE_START_MARKER}hello`, "detail"];
	render(): string[] {
		return [...this.lines];
	}
	invalidate(): void {}
}

describe("Message boundaries", () => {
	it("has zero display width and is removed from copied text", () => {
		assert.equal(visibleWidth(`${MESSAGE_START_MARKER}hello`), 5);
		assert.equal(stripTerminalSequences(`${MESSAGE_START_MARKER}hello`), "hello");
	});

	for (const program of ["iTerm.app", "kitty", "ghostty", "WezTerm", undefined]) {
		it(`advertises only neutral terminal marks (${program})`, () => {
			const previous = process.env.TERM_PROGRAM;
			try {
				if (program === undefined) delete process.env.TERM_PROGRAM;
				else process.env.TERM_PROGRAM = program;
				const terminal: Terminal = new ProcessTerminal();
				assert.equal(terminal.messageMark, program === "iTerm.app" ? ITERM_MARK : undefined);
			} finally {
				if (previous === undefined) delete process.env.TERM_PROGRAM;
				else process.env.TERM_PROGRAM = previous;
			}
		});
	}

	for (const mark of [ITERM_MARK, ""]) {
		it(`consumes message boundaries on initial render, redraw, resize, and overlays (${JSON.stringify(mark)})`, () => {
			const terminal = new RecordingTerminal();
			terminal.messageMark = mark;
			const tui = new TuiMainScreen(terminal);
			const component = new Messages();
			tui.addChild(component);
			try {
				for (const phase of ["initial", "streaming", "resize", "overlay", "redraw"]) {
					terminal.writes.length = 0;
					if (phase === "streaming") component.lines[0] = `${MESSAGE_START_MARKER}hello again`;
					if (phase === "resize") terminal.columns = 60;
					if (phase === "overlay") tui.showOverlay(new Messages());
					tui.renderNow(phase === "redraw");
					const output = terminal.writes.join("");
					assert.ok(output.includes("hello"), `${phase} must render content`);
					assert.ok(!output.includes(MESSAGE_START_MARKER), `${phase} leaked internal metadata`);
					assert.ok(!output.includes("\x1b]133;"), `${phase} announced shell activity`);
					assert.equal(output.includes(ITERM_MARK), Boolean(mark));
				}
			} finally {
				tui.stop();
			}
		});
	}

	for (const preserveScreen of [true, false]) {
		it(`strips fullscreen message metadata from overlays, flashes, and exit output (${preserveScreen})`, () => {
			const terminal = new RecordingTerminal();
			terminal.messageMark = ITERM_MARK;
			const tui = new TuiAltScreen(terminal);
			tui.addChild(new Messages());
			try {
				tui.start();
				tui.renderNow();
				tui.showOverlay(new Messages());
				tui.flash(`${MESSAGE_START_MARKER}notification`);
				tui.renderNow();
			} finally {
				tui.stop({ preserveScreen });
			}
			const output = terminal.writes.join("");
			assert.ok(output.includes("hello"));
			assert.ok(output.includes("notification"));
			assert.ok(!output.includes(MESSAGE_START_MARKER));
			assert.ok(!output.includes(ITERM_MARK));
			assert.ok(!output.includes("\x1b]133;"));
		});
	}

	it("does not reinterpret explicit shell sequences supplied by a component", () => {
		const terminal = new RecordingTerminal();
		terminal.messageMark = ITERM_MARK;
		const tui = new TuiMainScreen(terminal);
		const sequence = "\x1b]133;A\x07intentional\x1b]133;B\x07";
		tui.addChild({ render: () => [sequence], invalidate() {} });
		tui.renderNow();
		assert.ok(terminal.writes.join("").includes(sequence));
		tui.stop();
	});

	for (const mark of [ITERM_MARK, ""]) {
		it(`consumes boundaries before a full or differential render is chunked (${JSON.stringify(mark)})`, () => {
			const terminal = new RecordingTerminal();
			terminal.messageMark = mark;
			const tui = new TuiMainScreen(terminal);
			const component = new Messages();
			// Zero-width color sequences put the marker across the 1 MiB boundary
			// without an oversized visible line or a large image payload.
			const padding = "\x1b[0m".repeat((MAX_WRITE_CHARS - 12) / 4);
			component.lines = [`${padding}${MESSAGE_START_MARKER}hello`];
			tui.addChild(component);
			try {
				for (const suffix of ["hello", "changed"]) {
					component.lines = [`${padding}${MESSAGE_START_MARKER}${suffix}`];
					terminal.writes.length = 0;
					tui.renderNow();
					const output = terminal.writes.join("");
					assert.ok(terminal.writes.length > 1);
					assert.ok(terminal.writes.every((chunk) => chunk.length <= MAX_WRITE_CHARS));
					assert.ok(output.includes(`${padding}${mark}${suffix}`));
					if (mark && suffix === "hello") {
						const markOffset = output.indexOf(mark);
						assert.ok(
							markOffset < MAX_WRITE_CHARS && markOffset + mark.length > MAX_WRITE_CHARS,
							"the fixture must actually split the terminal mark across writes",
						);
					}
					assert.ok(!output.includes(MESSAGE_START_MARKER));
					assert.ok(!output.includes("\x1b]133;"));
				}
			} finally {
				tui.stop();
			}
		});
	}
});
