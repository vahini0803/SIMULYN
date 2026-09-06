import { io, type Socket } from 'socket.io-client';

import { API_URL, getAccessToken } from './api';

/**
 * socket.io-client reads the URL's path as the namespace, so handing it
 * `${API_URL}/proctoring` when API_URL carries a path — behind an ingress it is
 * `https://host/api` — would ask for a `/api/proctoring` namespace that does
 * not exist. The engine.io endpoint stays at the origin's `/socket.io/` either
 * way, so the origin is the right base here.
 */
function socketOrigin(): string {
  try {
    return new URL(API_URL, typeof window === 'undefined' ? undefined : window.location.href).origin;
  } catch {
    return API_URL;
  }
}

/**
 * Connects to the proctoring namespace. The access token travels in the
 * handshake; the gateway rejects the socket if it does not verify.
 */
export function createProctoringSocket(token?: string): Socket {
  return io(`${socketOrigin()}/proctoring`, {
    transports: ['websocket'],
    auth: { token: token ?? getAccessToken() ?? '' },
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    autoConnect: true,
  });
}

export type { Socket };
