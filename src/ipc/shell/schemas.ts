import z from "zod";

export const openExternalLinkInputSchema = z.object({
  url: z.url().refine(
    (value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    },
    {
      message: "Only HTTPS links can be opened externally.",
    }
  ),
});
