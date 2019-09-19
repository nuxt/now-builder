import { SpawnOptions } from 'child_process'
import path from 'path'
import fs from 'fs-extra'
import replaceInFile from 'replace-in-file'

import { PackageJson, glob, FileFsRef } from '@now/build-utils'

import { getNuxtConfig, getNuxtConfigName, exec } from './utils'

interface CompileTypescriptOptions {
    spawnOpts: SpawnOptions;
    rootDir: string;
    tscOptions?: string[];
}

interface PrepareTypescriptOptions {
    pkg: PackageJson;
    spawnOpts: SpawnOptions;
    rootDir: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function prepareTypescriptEnvironment ({ pkg, spawnOpts, rootDir }: PrepareTypescriptOptions): Promise<void> {
  spawnOpts = { ...spawnOpts, env: { ...spawnOpts.env, NODE_PRESERVE_SYMLINKS: '1' } }

  if ((fs.existsSync('tsconfig.json'))) {
    let tsConfig
    try {
      tsConfig = await fs.readJson('tsconfig.json')
    } catch (e) {
      throw new Error(`Can not read tsconfig.json from ${rootDir}`)
    }
    tsConfig.exclude = [ ...(tsConfig.exclude || []), 'node_modules_dev', 'node_modules_prod' ]
    await fs.writeJSON('tsconfig.json', tsConfig)
  }

  //   Edit dependencies
  if (pkg.dependencies && Object.keys(pkg.dependencies).includes('@nuxt/typescript-runtime')) {
    delete pkg.dependencies['@nuxt/typescript-runtime']
  }
}

function convertToOptions (options: string[]): string[] {
  return options.map((option, index) => !(index % 2) ? `--${option}` : `${option}`)
}

async function getTypescriptCompilerOptions (rootDir: string, options?: string[]): Promise<string[]> {
  let compilerOptions: string[] = []
  if (fs.existsSync('tsconfig.json')) {
    let tsConfig: { compilerOptions?: { [key: string]: string | number | boolean } }
    try {
      tsConfig = await fs.readJson('tsconfig.json')
    } catch (e) {
      throw new Error(`Can not read tsconfig.json from ${rootDir}`)
    }
    compilerOptions = Object.keys(tsConfig.compilerOptions || {}).reduce((options, option) => {
      if (tsConfig.compilerOptions && !['rootDirs', 'paths'].includes(option)) {
        options.push(option, String(tsConfig.compilerOptions[option]))
      }
      return options
    }, [] as string[])
  }
  if (options && Array.isArray(options)) {
    compilerOptions = [...compilerOptions, ...options]
  }
  return convertToOptions([ ...compilerOptions, 'noEmit', 'false', 'rootDir', rootDir, 'outDir', 'now_compiled' ])
}

export async function compileTypescriptBuildFiles ({ rootDir, spawnOpts, tscOptions }: CompileTypescriptOptions): Promise<{ [filePath: string]: FileFsRef }> {
  const nuxtConfigName = getNuxtConfigName(rootDir)
  const compilerOptions = await getTypescriptCompilerOptions(rootDir, tscOptions)
  fs.mkdirp('now_compiled')
  if (nuxtConfigName === 'nuxt.config.ts') {
    await exec('tsc', [...compilerOptions, nuxtConfigName], spawnOpts)
  }
  const nuxtConfigFile = getNuxtConfig(rootDir, 'now_compiled/nuxt.config.js')
  const { serverMiddleware, modules } = nuxtConfigFile

  const filesToCompile = [
    ...(serverMiddleware || []),
    ...(modules || [])
  ].reduce((filesToCompile, item) => {
    let itemPath = ''
    if (typeof item === 'string') {
      itemPath = item
    } else if (typeof item === 'object' && Array.isArray(item)) {
      itemPath = item[0]
    } else if (typeof item === 'object' && typeof item.handler === 'string') {
      itemPath = item.handler
    }
    if (itemPath) {
      const resolvedPath = path.resolve(rootDir, itemPath.replace(/^[@~]\//, './').replace(/\.ts$/, ''))
      if (fs.existsSync(`${resolvedPath}.ts`)) {
        filesToCompile.push(resolvedPath)
        replaceInFile.sync({
          files: path.resolve(rootDir, 'now_compiled/nuxt.config.js'),
          from: new RegExp(`(?<=['"\`])${itemPath}(?=['"\`])`, 'g'),
          to: itemPath.replace(/\.ts$/, '')
        })
      }
    }
    return filesToCompile
  }, [] as string[])
  await Promise.all(
    filesToCompile.map(file => exec('tsc', [...compilerOptions, file]))
  )
  const files = await glob('**', path.join(rootDir, 'now_compiled'))
  Object.keys(files).forEach((filename) => {
    const compiledPath = files[filename].fsPath
    const newPath = compiledPath.replace('/now_compiled/', '/')
    fs.moveSync(compiledPath, newPath, { overwrite: true })
    files[filename].fsPath = newPath
  })
  return files
}
