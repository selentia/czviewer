import { defineConfig, type Options } from 'tsup';

const extensionConfig: Options = {
  entry: {
    'background/background': 'src/background/background.ts',
    'background/latencyRouter': 'src/background/latencyRouter.ts',
    'background/fetchChannelName': 'src/background/fetchChannelName.ts',
    'background/injectedMain': 'src/background/injectedMain.ts',

    'content/liveContent': 'src/content/liveContent.ts',
    'content/multiviewBridge': 'src/content/multiviewBridge.ts',

    'popup/popup': 'src/popup/popup.ts',

    'shared/messages': 'src/shared/messages.ts',
    'shared/channelId': 'src/shared/channelId.ts',
  },

  outDir: './dist/extension',
  format: ['iife'],
  platform: 'browser',
  target: 'es2020',

  outExtension({ format }) {
    return format === 'iife' ? { js: '.js' } : {};
  },

  minify: true,
  minifyIdentifiers: false,
  keepNames: true,
  sourcemap: false,

  clean: true,
  dts: false,
};

export default defineConfig(extensionConfig);
