const esbuild = require('esbuild');

async function main() {
  try {
    const result = await esbuild.build({
      entryPoints: ['index.ts'],
      outfile: 'dist/index.js',
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      external: ['openclaw', 'neo4j-driver'],
      tsconfig: 'tsconfig.json',
      logLevel: 'info',
      legalComments: 'inline',
    });

    if (result.errors.length > 0) {
      console.error('[build] FAILED');
      result.errors.forEach(e => console.error('  ', e.text));
      process.exit(1);
    }
    console.log('[build] OK -> dist/index.js');
  } catch (err) {
    console.error('[build] EXCEPTION:', err.message);
    process.exit(1);
  }
}
main();
