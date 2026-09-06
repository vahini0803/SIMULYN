import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.IO adapter backed by Redis pub/sub.
 *
 * The proctoring gateway broadcasts entirely through rooms — a teacher watching
 * an exam sits in `teacher:<examId>`, each student in `attempt:<attemptId>`. The
 * default in-memory adapter only knows about rooms on its own process, so with
 * more than one API pod a violation raised on pod A never reaches the teacher
 * connected to pod B. This relays every room emit through Redis so all pods see
 * it, which is what makes horizontal scaling safe for live proctoring.
 *
 * Only used when REDIS_URL is set; a single-process install needs nothing.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly redisUrl: string,
  ) {
    super(app);
  }

  async connect(): Promise<void> {
    // The subscriber cannot be the publisher: a client in subscriber mode
    // refuses every other command, so Socket.IO needs a duplicate connection.
    const pubClient = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    const subClient = pubClient.duplicate();

    for (const client of [pubClient, subClient]) {
      // Without a handler an ECONNRESET reaches process level and takes the pod
      // down. ioredis reconnects on its own, so log and let it.
      client.on('error', (err: Error) => this.logger.error(`Redis: ${err.message}`));
    }

    await Promise.all([pubClient.ping(), subClient.ping()]);

    this.clients = [pubClient, subClient];
    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('Proctoring broadcasts relayed through Redis');
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  async disconnect(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.quit().catch(() => undefined)));
    this.clients = [];
  }
}
