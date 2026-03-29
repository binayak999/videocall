import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import { isTranslateAiNotConfiguredError, runTranslateText } from "../translate/translateText";

const router = Router();

const TEXT_MAX = 12_000;

router.post("/", authMiddleware, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = req.body as {
    text?: unknown;
    targetLanguage?: unknown;
    sourceLanguage?: unknown;
  };
  const text = typeof body.text === "string" ? body.text : "";
  const targetLanguage =
    typeof body.targetLanguage === "string" ? body.targetLanguage.trim() : "";
  const sourceLanguage =
    typeof body.sourceLanguage === "string" ? body.sourceLanguage.trim() : undefined;

  if (text.length === 0) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  if (targetLanguage.length === 0) {
    res.status(400).json({ error: "targetLanguage is required" });
    return;
  }
  if (text.length > TEXT_MAX) {
    res.status(400).json({ error: `text too long (max ${TEXT_MAX} characters)` });
    return;
  }

  try {
    const translated = await runTranslateText(text, targetLanguage, sourceLanguage);
    res.json({ translated });
  } catch (e: unknown) {
    if (isTranslateAiNotConfiguredError(e)) {
      res.status(503).json({
        error: "Translation is not configured on the server",
        detail: "Set HUGGINGFACE_API_TOKEN or OPENAI_API_KEY",
      });
      return;
    }
    const msg = e instanceof Error ? e.message : "Translation failed";
    console.error(e);
    res.status(502).json({ error: "Translation failed", detail: msg });
  }
});

export { router as translateRouter };
