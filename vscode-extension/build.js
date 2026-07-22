const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT_DIR = __dirname;
const OUT_DIR = path.join(EXT_DIR, 'out');

const isWatch = process.argv.includes('--watch');
const isProd = process.argv.includes('--prod');

async function build() {
  if (!isWatch) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const ctx = await esbuild.context({
    entryPoints: [path.join(EXT_DIR, 'src', 'extension.ts')],
    bundle: true,
    platform: 'node',
    target: ['node18'],
    external: ['vscode', 'sql.js'], // sql.js 由扩展运行时依赖提供，vscode 由扩展宿主提供
    format: 'cjs',
    outfile: path.join(OUT_DIR, 'extension.js'),
    sourcemap: !isProd,
    minify: isProd,
    define: { 'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development') },
  });

  if (isWatch) {
    await ctx.watch();
    console.log('👀 watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();

    const bundle = fs.readFileSync(path.join(OUT_DIR, 'extension.js'), 'utf8');
    const htmlStart = bundle.indexOf('<!DOCTYPE html>');
    const scriptStart = bundle.indexOf('<script>', htmlStart) + '<script>'.length;
    const scriptEnd = bundle.indexOf('</script>', scriptStart);
    if (htmlStart < 0 || scriptStart < '<script>'.length || scriptEnd < 0) {
      throw new Error('Console Webview script not found in extension bundle');
    }
    new vm.Script(bundle.slice(scriptStart, scriptEnd), { filename: 'console-webview.js' });
    console.log('  validated console Webview script');
  }

  // 复制静态资源
  const assets = ['media/coordinator.svg', 'schema.sql', 'index-schema.sql'];
  for (const asset of assets) {
    const src = path.join(EXT_DIR, asset);
    if (fs.existsSync(src)) {
      const dest = path.join(OUT_DIR, asset);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      console.log(`  copied ${asset}`);
    }
  }
  fs.cpSync(path.join(EXT_DIR, '..', 'src', 'skills'), path.join(OUT_DIR, 'skills'), { recursive: true });

  console.log(`✅ Build complete → out/`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
