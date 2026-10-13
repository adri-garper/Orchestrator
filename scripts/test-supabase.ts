import dotenv from 'dotenv';
import { getSupabase } from '../lib/supabase';

dotenv.config();

async function testConnection() {
  console.log('--- Verificando Configuración y Conexión con Supabase ---');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  console.log('\n1. Verificación de Variables de Entorno:');
  console.log(`- SUPABASE_URL: ${supabaseUrl ? `Definida (${supabaseUrl})` : '❌ NO DEFINIDA'}`);
  console.log(`- SUPABASE_SERVICE_ROLE_KEY: ${supabaseKey ? 'Definida (Oculta)' : '❌ NO DEFINIDA'}`);
  console.log(`- GEMINI_API_KEY: ${geminiKey ? 'Definida (Oculta)' : '⚠️ NO DEFINIDA (requerida para generar guiones)'}`);
  console.log(`- CRON_SECRET: ${process.env.CRON_SECRET ? 'Definida' : '⚪ No definida (opcional)'}`);

  if (!supabaseUrl || !supabaseKey) {
    console.error('\n❌ ERROR: Faltan variables obligatorias en el archivo .env.');
    console.error('Copia .env.example a .env y rellena SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  console.log('\n2. Probando conexión a Supabase...');
  try {
    const supabase = getSupabase();
    const startTime = Date.now();
    const { data, error } = await supabase
      .from('youtube_pipeline')
      .select('id, status, topic')
      .limit(5);

    const latency = Date.now() - startTime;

    if (error) {
      console.error(`\n❌ Error de consulta en Supabase (${latency}ms):`, error.message);
      if (error.code === '42P01') {
        console.error('👉 La tabla "youtube_pipeline" aún no existe en Supabase.');
        console.error('   Ejecuta el script "supabase_schema.sql" en el SQL Editor de tu panel de Supabase.');
      }
      process.exit(1);
    }

    console.log(`\n✅ ¡Conexión con Supabase exitosa! (${latency}ms)`);
    console.log(`- Tabla "youtube_pipeline" accesible correctamente.`);
    console.log(`- Filas encontradas: ${data?.length || 0}`);
    if (data && data.length > 0) {
      console.log('- Primeros elementos en cola:', data);
    }
  } catch (err: any) {
    console.error('\n❌ Error inesperado conectando a Supabase:', err.message || err);
    process.exit(1);
  }
}

testConnection();
