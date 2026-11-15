// SPDX-License-Identifier: Apache-2.0
// The in-memory RealtimeHub (architecture §9 port "RealtimeHub"): publish/subscribe per live session ("room"). It
// keeps one `RoomState` per room, runs the pure reducer and executes its effects on the connections' sinks. It
// knows nothing about WebSocket: the server wraps each socket in a `Sink`. State lives in memory only; after a
// restart the screen re-announces its state and the snapshot is rebuilt.

import { encodeFrame } from "./protocol.js";
import { type Connection, emptyRoom, type RoomEvent, type RoomState, reduce } from "./reducer.js";

/** What the hub needs from a connection. Both methods must never throw. */
export interface Sink {
  /** Sends a text frame. `volatile` frames may be dropped (laser) when the socket is congested. */
  send(text: string, volatile: boolean): void;
  close(code: number, reason: string): void;
}

export class RealtimeHub {
  private readonly rooms = new Map<string, RoomState>();
  private readonly sinks = new Map<string, { room: string; sink: Sink }>();

  /** Adds a connection to a room (creating the room) and greets it. */
  join(room: string, connection: Omit<Connection, "lastN">, sink: Sink): void {
    this.sinks.set(connection.id, { room, sink });
    this.dispatch(room, { kind: "join", connection });
  }

  /** Removes a connection (its socket closed). Unknown ids are ignored. */
  leave(connectionId: string): void {
    const entry = this.sinks.get(connectionId);
    if (!entry) return;
    this.sinks.delete(connectionId);
    this.dispatch(entry.room, { kind: "leave", connectionId });
  }

  /** Applies an event to a room and executes the resulting effects. */
  dispatch(room: string, event: RoomEvent): void {
    const before = this.rooms.get(room) ?? emptyRoom();
    const { state, effects } = reduce(before, event);
    if (state.connections.length === 0) this.rooms.delete(room);
    else this.rooms.set(room, state);
    for (const effect of effects) {
      const entry = this.sinks.get(effect.connectionId);
      if (!entry) continue;
      if (effect.kind === "send") {
        entry.sink.send(encodeFrame(effect.frame), effect.volatile === true);
      } else {
        this.sinks.delete(effect.connectionId);
        entry.sink.close(effect.code, effect.reason);
      }
    }
  }

  /** The room of a connection, if it is still connected. */
  roomOf(connectionId: string): string | undefined {
    return this.sinks.get(connectionId)?.room;
  }

  /** A copy-free read of a room's state (tests, diagnostics). */
  state(room: string): RoomState | undefined {
    return this.rooms.get(room);
  }

  /** Whether the room currently has a connected screen. */
  hasScreen(room: string): boolean {
    return (this.rooms.get(room)?.screen ?? null) !== null;
  }

  get connectionCount(): number {
    return this.sinks.size;
  }

  /** Closes every connection (shutdown: 1001 "going away"). */
  closeAll(code: number, reason: string): void {
    const all = [...this.sinks.values()];
    this.sinks.clear();
    this.rooms.clear();
    for (const { sink } of all) sink.close(code, reason);
  }
}
