import z from "zod";

export const openExternalLinkInputSchema = z.object({
  url: z.url().refine((value) => new URL(value).protocol === "https:", {
    message: "Only HTTPS links can be opened externally.",
  }),
});
