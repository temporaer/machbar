import type { FastifyInstance } from "fastify";

export const CLIENT_ID_HEADER = "x-machbar-client-id";

export interface ChangeEvent {
  id: number;
  originClientId: string | null;
}

type Subscriber = (event: ChangeEvent) => void;

export class ChangeNotifier {
  private nextId = 1;
  private readonly subscribers = new Set<Subscriber>();

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(originClientId: string | null): void {
    const event = { id: this.nextId++, originClientId };
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

function clientId(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length <= 128 ? value : null;
}

export function registerChangeNotifications(
  app: FastifyInstance,
  notifier: ChangeNotifier,
): void {
  app.get<{ Querystring: { clientId?: string } }>(
    "/api/changes",
    async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write("retry: 5000\n\n");

      const streamClientId = clientId(request.query.clientId);
      const unsubscribe = notifier.subscribe((event) => {
        if (
          streamClientId !== null &&
          event.originClientId === streamClientId
        ) {
          return;
        }
        reply.raw.write(`id: ${event.id}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => {
        reply.raw.write(": heartbeat\n\n");
      }, 25_000);
      heartbeat.unref();

      request.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  );

  app.addHook("onResponse", async (request, reply) => {
    if (
      !["POST", "PATCH", "DELETE"].includes(request.method) ||
      reply.statusCode < 200 ||
      reply.statusCode >= 300
    ) {
      return;
    }
    notifier.publish(clientId(request.headers[CLIENT_ID_HEADER]));
  });
}
