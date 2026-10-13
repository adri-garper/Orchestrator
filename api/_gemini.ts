import { GoogleGenAI } from '@google/genai';
import { ScriptData } from './_supabase';
import dotenv from 'dotenv';

dotenv.config();

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export function isRateLimitError(error: any): boolean {
  if (!error) return false;
  if (error instanceof QuotaExceededError) return true;

  const status = error.status || error.statusCode || error.response?.status;
  if (status === 429) return true;

  const msg = String(error.message || error.statusText || error).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  );
}

export async function generateYouTubeScript(topic: string): Promise<ScriptData> {
  const apiKey = (process.env.GEMINI_API_KEY || '').replace(/^["']|["']$/g, '').trim();
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY in environment variables.');
  }

  let modelName = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').replace(/^["']|["']$/g, '').trim();
  if (!modelName || modelName === 'gemini-1.5-pro') {
    modelName = 'gemini-2.5-flash';
  }
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
Eres un guionista y director creativo profesional para canales virales de YouTube de alta retención.
Desarrolla un guion completo, estructurado escena por escena, para un vídeo sobre el siguiente tema:

TEMA: "${topic}"

REGLAS DE PRODUCCIÓN:
1. Divide el vídeo en escenas de 5 a 12 segundos cada una para mantener el dinamismo visual.
2. Cada escena debe incluir:
   - "scene_number": número entero correlativo.
   - "duration_seconds": duración estimada (número).
   - "narration": texto de locución en español, con gancho inicial (hook), desarrollo cautivador y llamada a la acción (CTA).
   - "visual_description": explicación clara en español de lo que se verá en pantalla.
   - "image_prompt": prompt en inglés ultra detallado para un generador de imágenes (estilo cinematográfico, 8k, fotorrealista o conceptual).
   - "text_overlay": texto corto impactante para subtítulos o overlays en pantalla.
3. El resultado DEBE ser un objeto JSON válido con este formato:
{
  "title": "Título llamativo para YouTube",
  "target_audience": "Público objetivo",
  "total_estimated_duration_seconds": 120,
  "tags": ["tag1", "tag2", "tag3"],
  "scenes": [
    {
      "scene_number": 1,
      "duration_seconds": 6,
      "narration": "...",
      "visual_description": "...",
      "image_prompt": "cinematic hyperrealistic shot of...",
      "text_overlay": "..."
    }
  ]
}
`;

  const candidateModels = [
    modelName,
    'gemini-3.8-flash',
    'gemini-3.1-pro-preview',
  ].filter((v, i, a) => Boolean(v) && !v.includes('1.5') && !v.includes('2.5') && a.indexOf(v) === i);

  let lastError: any = null;

  for (const currentModel of candidateModels) {
    try {
      console.log(`[Gemini] Generating script with model: "${currentModel}"...`);
      const response = await ai.models.generateContent({
        model: currentModel,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const rawText = response.text;
      if (!rawText) {
        throw new Error(`Gemini (${currentModel}) returned an empty response.`);
      }

      // Clean potential markdown blocks if present
      const cleanedJson = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const script: ScriptData = JSON.parse(cleanedJson);

      if (!script.title || !Array.isArray(script.scenes) || script.scenes.length === 0) {
        throw new Error('Invalid script structure returned from Gemini model.');
      }

      console.log(`[Gemini] Script successfully generated with model: "${currentModel}"`);
      return script;
    } catch (err: any) {
      lastError = err;
      if (isRateLimitError(err)) {
        throw new QuotaExceededError(err.message || 'Gemini API 429 Quota Exceeded');
      }

      const errMsg = String(err.message || err).toLowerCase();
      // If 404 / model not supported / no longer available on this endpoint, try the next model
      if (
        errMsg.includes('404') ||
        errMsg.includes('not found') ||
        errMsg.includes('not supported') ||
        errMsg.includes('no longer available')
      ) {
        console.warn(`[Gemini] Model "${currentModel}" not available on this API key. Trying next fallback...`);
        continue;
      }

      throw err;
    }
  }

  throw new Error(`[Gemini Error] ${lastError?.message || lastError || 'All candidate Gemini models failed.'}`);
}
