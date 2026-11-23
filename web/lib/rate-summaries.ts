import { z } from "zod";

export const RATE_SUMMARY_REVALIDATE_SECONDS = 3600;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });

const rate = z
  .union([
    z.string().trim().regex(/^\d+(?:\.\d+)?$/),
    z.number().finite().nonnegative(),
  ])
  .transform((value) => (typeof value === "string" ? value : String(value)));

export const rateSummarySchema = z.object({
  pair: z.string().trim().min(1),
  date: isoDate,
  source: z.string().trim().min(1),
  sampleCount: z.number().int().nonnegative(),
  min: rate,
  p25: rate,
  median: rate,
  p75: rate,
  max: rate,
});

export type RateSummary = z.infer<typeof rateSummarySchema>;

export type RateSummaryError =
  | "not_configured"
  | "invalid_url"
  | "upstream_unavailable"
  | "invalid_payload";

export interface RateSummarySnapshot {
  ok: boolean;
  configured: boolean;
  error?: RateSummaryError;
  summaries: RateSummary[];
  readAt: string;
}

const responseSchema = z.union([
  z.array(rateSummarySchema),
  z.object({ summaries: z.array(rateSummarySchema) }),
]);

const sortSummaries = (summaries: readonly RateSummary[]) =>
  [...summaries].sort(
    (a, b) =>
      a.pair.localeCompare(b.pair) ||
      b.date.localeCompare(a.date) ||
      a.source.localeCompare(b.source),
  );

export function latestRateSummaries(summaries: readonly RateSummary[]): RateSummary[] {
  const latest = new Map<string, RateSummary>();
  for (const summary of summaries) {
    const key = `${summary.pair}\u0000${summary.source}`;
    const previous = latest.get(key);
    if (!previous || summary.date > previous.date) latest.set(key, summary);
  }
  return sortSummaries([...latest.values()]);
}

export async function fetchRateSummaries(
  configuredUrl: string | undefined = process.env.RATE_SUMMARIES_URL,
): Promise<RateSummarySnapshot> {
  const readAt = new Date().toISOString();
  const failed = (
    error: RateSummaryError,
    configured: boolean,
  ): RateSummarySnapshot => ({ ok: false, configured, error, summaries: [], readAt });

  if (!configuredUrl?.trim()) return failed("not_configured", false);

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    return failed("invalid_url", true);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return failed("invalid_url", true);
  }

  try {
    const init = {
      cache: "force-cache",
      next: { revalidate: RATE_SUMMARY_REVALIDATE_SECONDS },
    } as Parameters<typeof fetch>[1];
    const response = await fetch(url.toString(), init);
    if (!response.ok) return failed("upstream_unavailable", true);

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) return failed("invalid_payload", true);

    const summaries = Array.isArray(parsed.data) ? parsed.data : parsed.data.summaries;
    return { ok: true, configured: true, summaries: sortSummaries(summaries), readAt };
  } catch {
    return failed("upstream_unavailable", true);
  }
}
