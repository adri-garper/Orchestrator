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

  const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-pro';
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

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const rawText = response.text;
    if (!rawText) {
      throw new Error('Gemini returned an empty response.');
    }

    // Clean potential markdown blocks if present
    const cleanedJson = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const script: ScriptData = JSON.parse(cleanedJson);

    if (!script.title || !Array.isArray(script.scenes) || script.scenes.length === 0) {
      throw new Error('Invalid script structure returned from Gemini model.');
    }

    return script;
  } catch (err: any) {
    if (isRateLimitError(err)) {
      throw new QuotaExceededError(err.message || 'Gemini API 429 Quota Exceeded');
    }
    throw err;
  }
}
