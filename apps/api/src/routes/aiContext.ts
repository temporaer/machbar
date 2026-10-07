import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { parseOrThrow } from "../validation.js";
import { getHouseholdAiContext, HOUSEHOLD_AI_CONTEXT_ID } from "../aiContext.js";
import { nowIso } from "../domain/workItemShared.js";

const aiContextInputSchema = z.object({
  householdDescription: z.string().max(3000).nullable().optional(),
  longTermDirection: z.string().max(2000).nullable().optional(),
  suggestionGuidance: z.string().max(2000).nullable().optional(),
}).strict();

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

export function registerAiContextRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/settings/ai-context", async () => getHouseholdAiContext(db));

  app.put("/api/settings/ai-context", async (request) => {
    const input = parseOrThrow(aiContextInputSchema, request.body);
    const values = {
      id: HOUSEHOLD_AI_CONTEXT_ID,
      householdDescription: clean(input.householdDescription),
      longTermDirection: clean(input.longTermDirection),
      suggestionGuidance: clean(input.suggestionGuidance),
      updatedAt: nowIso(),
    };
    db.insert(schema.householdAiContext)
      .values(values)
      .onConflictDoUpdate({
        target: schema.householdAiContext.id,
        set: {
          householdDescription: values.householdDescription,
          longTermDirection: values.longTermDirection,
          suggestionGuidance: values.suggestionGuidance,
          updatedAt: values.updatedAt,
        },
      })
      .run();
    return getHouseholdAiContext(db);
  });
}
