// SPDX-License-Identifier: AGPL-3.0-or-later
// Port selection: the default port moves to the next free one when it is busy; a port the person chose does not.
import { connect, createServer } from "node:net";

/** True when something already accepts TCP connections on the loopback address at this port. */
export function isAnswering(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** True when this process could listen on `host:port` right now (the probe socket is closed again). */
export function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * Some systems let a second program bind 127.0.0.1:8080 while another one listens on 0.0.0.0:8080; checking that
 * nothing answers too avoids starting "successfully" on a port the browser would send to the other program.
 */
export async function isFree(host: string, port: number): Promise<boolean> {
  if (await isAnswering(port)) return false;
  return canBind(host, port);
}

/** How many ports after the default are tried before giving up. */
export const PORT_ATTEMPTS = 20;

/** Candidate ports in order: just the chosen one, or the default and the next ones. */
export function candidatePorts(start: number, explicit: boolean): number[] {
  if (explicit) return [start];
  const ports: number[] = [];
  for (let p = start; p < start + PORT_ATTEMPTS && p <= 65535; p++) ports.push(p);
  return ports;
}
