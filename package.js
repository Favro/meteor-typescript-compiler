/**
 * Match these with the versions in the meteor-typescript/package.js
 */
const COMPILER_VERSION = "1.0.0";
const TYPESCRIPT_VERSION = "5.9.3";

Package.describe({
  name: "refapp:meteor-typescript-compiler",
  version: COMPILER_VERSION,
  summary: "A Typescript compiler plugin for Meteor",
  git: "https://github.com/Meteor-Community-Packages/meteor-typescript-compiler",
  documentation: "README.md",
});

Npm.depends({
  "typescript": TYPESCRIPT_VERSION,
  "chalk": "4.1.2",
  "@types/node": "14.18.63",
});

Package.onUse(function (api) {
  api.versionsFrom("2.7");
  api.use(["babel-compiler"], "server");
  api.use(["typescript@4.0.0||5.0.0||6.0.0"], "server"); // For compiling this package
  api.addFiles(["meteor-typescript-compiler.ts"], "server");
  api.export(["MeteorTypescriptCompiler"], "server");
});

Package.onTest(function (api) {
  api.use("tinytest");
  api.use("typescript");
  api.use("refapp:meteor-typescript-compiler");
  api.mainModule("tests.ts");
});
