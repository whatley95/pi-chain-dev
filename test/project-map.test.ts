import assert from "node:assert";
import { describe, it, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateProjectMap, loadProjectMap, saveProjectMap, getMapPath, summarizeMapForPrompt } from "../src/project-map.js";

describe("project-map", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("detects a Flutter project", () => {
    const cwd = makeTempDir("cdev-flutter-");
    writeFileSync(join(cwd, "pubspec.yaml"), "name: flutter_app\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf-8");
    mkdirSync(join(cwd, "lib"));
    mkdirSync(join(cwd, "lib", "features"));
    mkdirSync(join(cwd, "lib", "features", "auth"));
    writeFileSync(join(cwd, "lib", "main.dart"), "void main() {}\n", "utf-8");
    writeFileSync(join(cwd, "lib", "features", "auth", "auth.dart"), "class Auth {}\n", "utf-8");

    const map = generateProjectMap(cwd);
    assert.strictEqual(map.project.type, "flutter-mobile");
    assert.ok(map.project.languages.includes("Dart"));
    assert.ok(map.stack.mobile.includes("Flutter"));
    assert.ok(map.project.entryPoints.includes("lib/main.dart"));
    assert.ok(map.structure.sourceRoots.includes("lib"));
    assert.ok(map.config.runCommands.includes("flutter run"));
    assert.ok(map.structure.dirs.some((d) => d.path === "lib/features"));
    assert.ok(map.structure.boundaries.some((b) => b.name === "features"));
  });

  it("detects a Spring Boot project", () => {
    const cwd = makeTempDir("cdev-spring-");
    writeFileSync(
      join(cwd, "build.gradle"),
      'plugins {\n  id "java"\n  id "org.springframework.boot" version "3.0.0"\n}\ndependencies {\n  implementation "org.springframework.boot:spring-boot-starter-web"\n}\n',
      "utf-8"
    );
    mkdirSync(join(cwd, "src", "main", "java", "com", "example"), { recursive: true });
    mkdirSync(join(cwd, "src", "main", "java", "com", "example", "user"), { recursive: true });
    writeFileSync(join(cwd, "src", "main", "java", "com", "example", "Application.java"), "package com.example;\n", "utf-8");
    writeFileSync(join(cwd, "src", "main", "java", "com", "example", "user", "UserController.java"), "package com.example.user;\n", "utf-8");

    const map = generateProjectMap(cwd);
    assert.strictEqual(map.project.type, "spring-boot-backend");
    assert.ok(map.project.languages.includes("Java"));
    assert.ok(map.stack.backend.includes("Spring Boot"));
    assert.ok(map.config.runCommands.includes("./gradlew bootRun"));
    assert.ok(map.dependencies.springBoot?.some((d) => d.includes("web")));
    assert.ok(map.routes?.spring?.length);
    assert.ok(map.structure.boundaries.some((b) => b.name === "controller"));
    assert.ok(map.structure.dirs.some((d) => d.path === "src/main/java/com/example"));
  });

  it("detects JS/TS dependencies and file tree", () => {
    const cwd = makeTempDir("cdev-node-");
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "node-app",
        dependencies: { react: "^18", zustand: "^4" },
        devDependencies: { vite: "^4", jest: "^29" },
      }),
      "utf-8"
    );
    mkdirSync(join(cwd, "src", "components"), { recursive: true });
    writeFileSync(join(cwd, "src", "main.tsx"), "export {}\n", "utf-8");
    writeFileSync(join(cwd, "src", "components", "App.tsx"), "export {}\n", "utf-8");

    const map = generateProjectMap(cwd);
    assert.ok(map.project.languages.includes("JavaScript"));
    assert.ok(map.dependencies.node?.includes("react"));
    assert.ok(map.dependencies.nodeDev?.includes("vite"));
    assert.ok(map.files.tree.some((l) => l.includes("components/")));
    assert.ok(map.files.keyFiles.includes("package.json"));
    assert.ok(map.stack.build.includes("Vite"));
    assert.ok(map.structure.dirs.some((d) => d.path === "src/components"));
    assert.ok(Object.keys(map.structure.fileCountsByExtension).length > 0);
  });

  it("detects Python dependencies", () => {
    const cwd = makeTempDir("cdev-python-");
    writeFileSync(join(cwd, "requirements.txt"), "flask\nrequests\n", "utf-8");
    writeFileSync(join(cwd, "app.py"), "from flask import Flask\n", "utf-8");

    const map = generateProjectMap(cwd);
    assert.ok(map.project.languages.includes("Python"));
    assert.ok(map.project.entryPoints.includes("app.py"));
    assert.ok(map.config.testCommands.includes("pytest"));
    assert.ok(map.dependencies.python?.includes("flask"));
  });

  it("saves and loads a project map", () => {
    const cwd = makeTempDir("cdev-map-persist-");
    const map = generateProjectMap(cwd);
    saveProjectMap(cwd, map);

    const loaded = loadProjectMap(cwd);
    assert.ok(loaded);
    assert.strictEqual(loaded.project.name, map.project.name);
    assert.ok(existsSync(getMapPath(cwd)));
  });

  it("summarizes map for prompt injection", () => {
    const cwd = makeTempDir("cdev-map-summary-");
    writeFileSync(join(cwd, "pubspec.yaml"), "name: x\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf-8");
    mkdirSync(join(cwd, "lib"));
    writeFileSync(join(cwd, "lib", "main.dart"), "void main() {}\n", "utf-8");

    const map = generateProjectMap(cwd);
    const summary = summarizeMapForPrompt(map);
    assert.ok(summary.includes("<project_map>"));
    assert.ok(summary.includes("Dart"));
    assert.ok(summary.includes("flutter-mobile") || summary.includes("Flutter"));
    assert.ok(summary.includes("</project_map>"));
    assert.ok(summary.includes("Boundaries:") || summary.includes("Source roots:"));
  });
});
