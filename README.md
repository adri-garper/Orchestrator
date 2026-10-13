# 🎬 Orchestrator (Serverless YouTube AI Pipeline)

Un orquestador 100% Serverless para la generación automática de vídeos y contenido con inteligencia artificial, desplegado en **Vercel**, respaldado por **Supabase** y potenciado por la nueva API de **Google Gemini 1.5 Pro** (`@google/genai`).

Diseñado para funcionar sin necesidad de servidores encendidos 24/7: se despierta periódicamente con Cron, procesa la cola de trabajo, gestiona automáticamente las pausas de cuota de Google (errores 429) y deja el material listo para renderizar en tu PC con aceleración gráfica GPU.

---

## 🏛️ Arquitectura del Sistema

```
                      ┌──────────────────────────────────────┐
                      │    Vercel Cron / GitHub Action       │
                      │       (Se activa cada 15 min)        │
                      └──────────────────┬───────────────────┘
                                         │ GET/POST /api/orchestrator
                                         ▼
                      ┌──────────────────────────────────────┐
                      │    Vercel Serverless Function        │
                      │         (api/orchestrator.ts)        │
                      └──────────────┬────────────┬──────────┘
                                     │            │
            1. Lee / Actualiza estado│            │ 2. Genera guion escena
                                     ▼            ▼    por escena (JSON)
                    ┌──────────────────┐        ┌──────────────────┐
                    │     Supabase     │        │  Google Gemini   │
                    │ Database/Storage │        │     1.5 Pro      │
                    │(youtube_pipeline)│        │  (@google/genai) │
                    └────────┬─────────┘        └──────────────────┘
                             │
                             │ Estado: 'ready_for_pc'
                             ▼
                    ┌──────────────────────────────────────┐
                    │           Tu PC a Demanda            │
                    │   (local_worker/render_worker.py)    │
                    │  TTS + FFmpeg (GPU NVENC) -> .mp4   │
                    └──────────────────────────────────────┘
```

---

## ⚡ Características Principales

1. **Gestión Inteligente de Cuota (429 Rate Limit Cooldown)**:
   - Si Gemini devuelve un error `429 Too Many Requests` o `RESOURCE_EXHAUSTED`, el orquestador marca el vídeo como `paused_quota` y anota la hora.
   - En las siguientes llamadas del Cron, el orquestador revisa el tiempo transcurrido: si no han pasado las **4 horas de enfriamiento**, corta la ejecución de inmediato respondiendo en milisegundos y consumiendo **0 recursos**.
   - Pasadas las 4 horas, reactiva automáticamente el trabajo a `pending`.

2. **Panel Web Integrado (`/`)**:
   - Accede a tu URL de Vercel para ver métricas en tiempo real: cuántos vídeos están en espera, en proceso, en pausa de cuota o listos para tu PC.
   - Botón para **Ejecutar Ahora** manualmente y formulario para **añadir nuevos temas** a la cola.

3. **Renderizado en PC por Lote**:
   - Cuando enciendas el ordenador, ejecutas el script `render_worker.py`.
   - Consulta a Supabase si hay vídeos con estado `ready_for_pc`. Si los hay, genera la voz en off con Edge-TTS y renderiza el vídeo final a 1080p usando tu tarjeta gráfica (NVIDIA NVENC).

---

## 🚀 Guía de Puesta en Marcha Paso a Paso

### Paso 1: Crear el Repositorio en GitHub y Subir el Código

1. Entra en [GitHub -> New Repository](https://github.com/new).
2. Nómbralo **`Orchestrator`** (puedes dejarlo público o privado).
3. Desde tu terminal en la carpeta del proyecto, sube los cambios:
   ```bash
   cd C:\Users\adrig\Documents\Proyects\Orchestrator
   git add .
   git commit -m "feat: initial commit for YouTube AI Orchestrator"
   git push -u origin main
   ```

---

### Paso 2: Configurar Supabase

1. Entra en tu panel de [Supabase](https://supabase.com) y selecciona tu proyecto.
2. Ve al **SQL Editor** en el menú lateral izquierdo.
3. Copia todo el contenido de [`supabase_schema.sql`](file:///C:/Users/adrig/Documents/Proyects/Orchestrator/supabase_schema.sql) y dale a **Run**.
   - Esto creará la tabla `youtube_pipeline`, los índices y el bucket de almacenamiento `youtube-assets`.

---

### Paso 3: Desplegar en Vercel

1. Entra en [Vercel](https://vercel.com) y pulsa en **"Add New..." -> "Project"**.
2. Selecciona el repositorio **`Orchestrator`** que acabas de subir a GitHub.
3. En la sección **Environment Variables**, añade las siguientes variables:

| Variable | Descripción | Ejemplo |
| :--- | :--- | :--- |
| `SUPABASE_URL` | URL de tu proyecto Supabase | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave secreta Service Role de Supabase | `eyJhbGciOi...` |
| `GEMINI_API_KEY` | Clave de API de Google AI Studio | `AIzaSy...` |
| `GEMINI_MODEL` | Modelo a utilizar (opcional, default: `gemini-1.5-pro`) | `gemini-1.5-pro` |
| `CRON_SECRET` | Token secreto aleatorio para proteger la API (opcional) | `tu-clave-secreta-123` |
| `QUOTA_COOLDOWN_HOURS` | Horas de espera tras un error 429 (default: `4`) | `4` |

4. Pulsa **Deploy**. En menos de 1 minuto estará operativo.

---

### ⏱️ Sobre los Cron Jobs de Vercel (Hobby vs Pro)

- **Vercel Pro**: Admite la regla `*/15 * * * *` de [`vercel.json`](file:///C:/Users/adrig/Documents/Proyects/Orchestrator/vercel.json) directamente cada 15 minutos sin hacer nada más.
- **Vercel Hobby (Gratuito)**: Vercel solo permite cron jobs programados **una vez al día** en su plan gratuito.
  - **Solución 100% gratuita incluida**: En este repositorio tienes listo un flujo de **GitHub Actions** en [`.github/workflows/cron.yml`](file:///C:/Users/adrig/Documents/Proyects/Orchestrator/.github/workflows/cron.yml).
  - Solo añade los siguientes **Secrets** en tu repositorio de GitHub (*Settings -> Secrets and variables -> Actions*):
    - `VERCEL_APP_URL`: La URL de tu app en Vercel (ej: `https://orchestrator-xxx.vercel.app`).
    - `CRON_SECRET`: El mismo token que configuraste en Vercel.
  - ¡Y GitHub Actions se encargará de despertar a Vercel cada 15 minutos sin pagar un solo céntimo!

---

### Paso 4: Renderizado Final en tu PC

En tu ordenador (cuando quieras procesar los vídeos generados):

1. Abre una consola en la subcarpeta `local_worker`:
   ```bash
   cd local_worker
   pip install -r requirements.txt
   ```
2. Asegúrate de tener instalado **FFmpeg** en tu sistema y accesible en el PATH.
3. Copia el archivo `.env.example` a `.env` en la raíz con tus credenciales de Supabase.
4. Ejecuta el worker:
   ```bash
   # Para procesar los vídeos pendientes una sola vez y salir:
   python render_worker.py --once

   # O para dejarlo vigilando en segundo plano mientras juegas o trabajas:
   python render_worker.py --poll-interval 30
   ```
5. El worker generará el audio de cada escena, ensamblará el vídeo utilizando tu tarjeta gráfica (NVIDIA NVENC) y guardará el `.mp4` en la carpeta `local_worker/output/`.

---

## 📂 Estructura del Proyecto

```
Orchestrator/
├── api/
│   ├── orchestrator.ts       # Endpoint principal invocado por el Cron Job
│   ├── status.ts             # API de monitoreo de cola y creación de tareas
│   └── lib/
│       ├── supabase.ts       # Cliente Supabase tipado y modelos de datos
│       └── gemini.ts         # Integración con Google Gemini (@google/genai)
├── local_worker/
│   ├── render_worker.py      # Worker local de renderizado con GPU / FFmpeg
│   └── requirements.txt      # Dependencias Python (supabase, edge-tts, etc.)
├── public/
│   └── index.html            # Dashboard web visual con Tailwind CSS
├── .github/workflows/
│   └── cron.yml              # Scheduler gratuito alternativo cada 15 min
├── supabase_schema.sql       # Script SQL para inicializar Supabase
├── vercel.json               # Configuración oficial de Cron para Vercel
├── package.json              # Configuración y dependencias Node/TypeScript
├── tsconfig.json             # Configuración de TypeScript
└── .env.example              # Plantilla de variables de entorno
```
