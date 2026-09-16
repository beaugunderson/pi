/**
 * Internal, zero-width message boundary, encoded as an APC like CURSOR_MARKER.
 * Components prepend it to a message's first line. Renderers consume it for
 * navigation; it must never reach the terminal as a shell-prompt sequence.
 */
export const MESSAGE_START_MARKER = "\x1b_pi:message-start\x07";
