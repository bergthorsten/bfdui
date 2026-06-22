import path from "node:path";
import "dotenv/config";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { PublisherGithub } from "@electron-forge/publisher-github";
import type { ForgeConfig } from "@electron-forge/shared-types";

const iconPath = path.resolve(import.meta.dirname, "assets", "icon");
const appleSigningIdentity = process.env.APPLE_SIGNING_IDENTITY;
const appleKeychain = process.env.APPLE_KEYCHAIN;
const appleId = process.env.APPLE_ID;
const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
const appleTeamId = process.env.APPLE_TEAM_ID;

const macPackagerConfig = appleSigningIdentity
  ? {
      osxSign: {
        identity: appleSigningIdentity,
        ...(appleKeychain ? { keychain: appleKeychain } : {}),
      },
      ...(appleId && appleIdPassword && appleTeamId
        ? {
            osxNotarize: {
              appleId,
              appleIdPassword,
              teamId: appleTeamId,
            },
          }
        : {}),
    }
  : {};

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: "de.bergfreunde.bfd-desktop",
    asar: true,
    icon: iconPath,
    ...macPackagerConfig,
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ setupIcon: `${iconPath}.ico` }),
    new MakerDMG({
      format: "UDZO",
      icon: `${iconPath}.icns`,
      overwrite: true,
      contents: (options) => [
        { x: 180, y: 170, type: "file", path: options.appPath },
        { x: 480, y: 170, type: "link", path: "/Applications" },
      ],
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerRpm({ options: { icon: `${iconPath}.png` } }),
    new MakerDeb({ options: { icon: `${iconPath}.png` } }),
  ],
  publishers: [
    new PublisherGithub({
      draft: false,
      force: true,
      generateReleaseNotes: true,
      repository: {
        name: "bfdui",
        owner: "bergthorsten",
      },
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),

    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
