import { spawn } from 'node:child_process';
import stream from 'node:stream';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'path';
import { JSONAST, ObjectToken } from '@playkostudios/jsonc-ast';
import { ChildProcessWithoutNullStreams } from 'child_process';

const defaultWLBin = 'WonderlandEditor';
const defaultWindowsWLPath = `C:\\Program Files\\Wonderland\\WonderlandEngine\\bin\\${defaultWLBin}.exe`;
const wlProjectName = 'gltf-to-wl-bin';
let tmpDir: string | null = null;

type Version = [major: number, minor: number, patch: number];
interface Model { modelPath: string, modelFileName: string, outputName: string }

async function generateProject(templateProject: string, version: Version, keepOtherResources: boolean): Promise<JSONAST> {
    console.info(`Generating actual template project file...`);
    const genProject = new JSONAST();
    await genProject.parse(templateProject);
    const rootProject = ObjectToken.assert(genProject.root!.getValueToken());

    rootProject.setValueOfKey('objects', {});

    if (!keepOtherResources) {
        rootProject.setValueOfKey('meshes', {});
        rootProject.setValueOfKey('textures', {});
        rootProject.setValueOfKey('images', {});
        rootProject.setValueOfKey('materials', {});
        rootProject.setValueOfKey('animations', {});
        rootProject.setValueOfKey('skins', {});
    }

    const settings = ObjectToken.assert(rootProject.getValueTokenOfKey('settings'));
    const project = ObjectToken.assert(settings.getValueTokenOfKey('project'));
    project.setValueOfKey('name', wlProjectName);
    project.setValueOfKey('version', version);
    project.setValueOfKey('packageForStreaming', true);
    return genProject;
}

class UserError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UserError';
    }
}

class UsageError extends UserError {
    constructor(message: string) {
        super(`Invalid usage; ${message}`);
    }
}

function printHelp() {
    const progName = `${process.argv[0]} ${process.argv[1]}`;

    console.log(`\
Usage: ${progName} [--output-folder <output_folder_path>] [--wonderland-path <wonderland_editor_executable_path>] [-- [<model_file>] [<model_file_2>] [...]] [-- <wonderland_editor_args...>]
Optional arguments (or groups of arguments) are denoted by square brackets. Greater/lesser than signs denote a single argument.

Note that, if running from an npm script (npm run ...), then an extra mark (--) at the beginning of the argument list is needed:
$ npm run (script name) -- (actual arguments list...)

Example usage:
$ ${progName} --output-folder static/bins/ -- models/
- Compiles all models in the "models" folder and puts the compiled bin models in the "static/bins" folder.
$ ${progName} --output-folder static/bins/ -- models/player.glb models/football.glb models/low_poly_tree.glb
- Compiles a selection of models in the "models" folder. Outputs to a "static/bins" folder.

Available arguments:
- --output-folder <output_folder_path>: The folder where all the generated .bin files will be put. Uses the current directory by default.
- --wonderland-path <wonderland_editor_executable_path>: The path to the Wonderland Engine editor (a simple executable name instead of a path works too). If not specified, then "${defaultWindowsWLPath}" will be used as the executable for Windows, and "${defaultWLBin}" will be used for any other OS.
- --projects-only: Only generate project files instead of converting to bin files.
- --template-project-path: A path to an existing project file. The default shader, texture, material, etc... IDs from this project will be used for the generated projects.
- --version <major> <minor> <patch>: The version number to use for the generated project files. If none is supplied, then the current version is detected by running "WonderlandEditor --help".
- --use-links: If passed, then file links will be used when building models to save storage space. Note that hard links will be used instead of symbolic links on Windows, since Windows users can't create symbolic links without changing group policies. Enabled by default.
- --use-symlinks: Equivalent to "--use-links". Kept for backwards-compatibility.
- --no-links: Opposite of "--use-links".
- --keep-other-resources: If passed, then project resources other than pipelines and shaders are also kept. Disabled by default.

Available arguments after first mark (--):
- <model_file>: The path to the model file that needs to be compiled. If this is a path to a folder, then the folder will be scanned non-recursively for GLTF/GLB files.

Available arguments after second mark (--):
- <wonderland_editor_args...>: The list of arguments to pass to the Wonderland Engine editor when generating bin files. This might be needed if, for example, there are no cached credentials for the Wonderland Engine editor, or the EULA is not accepted yet.

Note that if no model file list is specified (arguments after the first mark (--)), then the default model locations will be used, which are:
- model.gltf
- model.glb`
    );
}

function removeTmpDir() {
    try {
        if (tmpDir !== null) {
            fs.rmSync(tmpDir, { recursive: true });
            tmpDir = null;
        }
    } catch(e) {
        console.error(`Failed to remove temporary directory "${tmpDir}". Please manually remove it.`);
        throw e;
    }
}

let childProc: ChildProcessWithoutNullStreams | null = null;

function spawnWLE(workingDir: string, wonderlandPath: string, wonderlandArgs: string[], pipeStdout: NodeJS.WritableStream | null = null, pipeStderr: NodeJS.WritableStream | null = null) {
    if (pipeStdout === null) pipeStdout = process.stdout;
    if (pipeStderr === null) pipeStderr = process.stderr;

    console.info('Spawning process:', wonderlandPath, ...wonderlandArgs);

    return new Promise<void>((resolve, reject) => {
        childProc = spawn(wonderlandPath, wonderlandArgs, {
            cwd: workingDir,
            windowsHide: true
        });

        let done = false;
        childProc.on('exit', (code, signal) => {
            if (done) {
                return;
            }

            done = true;
            childProc = null;

            if (code === 0) {
                resolve();
            } else {
                reject(new UserError(`Wonderland Engine editor exited with code ${code} and signal ${signal}.`));
            }
        });

        childProc.on('error', (err) => {
            if (done) {
                return;
            }

            done = true;
            childProc = null;

            reject(err);
        });

        childProc.stdout.pipe(pipeStdout!);
        childProc.stderr.pipe(pipeStderr!);
    });
}

class StringStream extends stream.Writable {
    private strParts: string[] = [];

    _write(chunk: any, _enc: BufferEncoding, next: (error?: Error | null) => void) {
        this.strParts.push(chunk.toString());
        next();
    }

    toString() {
        if (this.strParts.length === 0) {
            return '';
        }

        if (this.strParts.length > 1) {
            this.strParts.splice(0, this.strParts.length, this.strParts.join(''));
        }

        return this.strParts[0];
    }
}

async function detectVersion(wonderlandPath: string): Promise<Version> {
    console.info('Detecting Wonderland Engine version...');

    try {
        let outStr: string;
        {
            const outStream = new StringStream();

            try {
                await spawnWLE(
                    process.cwd(),
                    wonderlandPath,
                    ['--version'],
                    outStream
                );
            } catch(_) {
                await spawnWLE(
                    process.cwd(),
                    wonderlandPath,
                    ['--help'],
                    outStream
                );
            }

            outStr = outStream.toString();
        }

        const versionRegex = /Wonderland (?:Engine|Editor version) ([0-9]+)\.([0-9]+)\.([0-9]+)/g;
        const matches = versionRegex.exec(outStr);

        if (matches === null || matches.length !== 4) {
            throw new UserError('Could not find version string in help command.');
        }

        const version = [Number(matches[1]), Number(matches[2]), Number(matches[3])] as Version;

        console.info(`Detected version ${version.join('.')}.`);

        return version;
    } catch(e) {
        if (e instanceof UserError) {
            throw new UserError(`Failed to detect version; ${e.message}`);
        } else {
            throw e;
        }
    }
}

async function importPackageProject(projectPath: string, workingDir: string, wonderlandPath: string, wonderlandArgs: string[], modelPath: string) {
    console.info('Compiling to bin model...');

    try {
        await spawnWLE(
            workingDir,
            wonderlandPath,
            ['--import', modelPath, '--project', projectPath, '--package', /*'--windowless',*/ ...wonderlandArgs]
        );
    } catch(e) {
        if (e instanceof UserError) {
            throw new UserError(`bin compilation failed; ${e.message}`);
        } else {
            throw e;
        }
    }
}

function addInputModel(models: Model[], modelPath: string) {
    const modelFileName = path.basename(modelPath);
    const modelExt = path.extname(modelFileName);
    const extLen = modelExt.length;
    if (extLen === 0 || (modelExt !== '.gltf' && modelExt !== '.glb')) {
        throw new UserError(`Unknown file extension for path "${modelPath}". Must be either ".gltf" or ".glb"`);
    }

    let baseFileName = modelFileName.substring(0, modelFileName.length - extLen);
    let outputName = baseFileName + '.bin';

    for (const { modelPath: oModelPath, outputName: oName } of models) {
        if (oName === outputName) {
            throw new UsageError(`Multiple model files have the same name (excluding the extension): "${oModelPath}" and "${modelPath}". Please rename files that share this name.`);
        }
    }

    models.push({ modelPath, modelFileName, outputName });
}

function linkOrCopy(onWindows: boolean, useLinks: boolean, src: string, dst: string) {
    if (useLinks) {
        try {
            if (onWindows) {
                fs.linkSync(src, dst);
            } else {
                fs.symlinkSync(src, dst, 'file');
            }
        } catch(err) {
            console.error(err);
            console.warn(`Failed to create ${onWindows ? 'hard' : 'symbolic'} link. Falling back to file copying`);
            useLinks = false;
        }
    }

    if (!useLinks) {
        fs.copySync(src, dst);
    }
}

async function main() {
    try {
        // parse arguments
        const onWindows = process.platform === 'win32';
        let models: Model[] = [];
        let outputFolder: string | null = null;
        let wonderlandArgs: string[] = [];
        let mark = 0;
        let wonderlandPath: string | null = null;
        let projectsOnly = false;
        let templateProject: string | null = null;
        let version: Version | null = null;
        let useLinks = true;
        let keepOtherResources = false;

        for (let i = 2; i < process.argv.length; i++) {
            const arg = process.argv[i];

            if (mark === 0) {
                switch(arg) {
                    case '--':
                        mark = 1;
                        break;
                    case '--output-folder':
                        i++;
                        if (i >= process.argv.length) {
                            throw new UsageError('Expected path after --output-folder argument, found nothing.');
                        }

                        if (outputFolder !== null) {
                            throw new UsageError('Can only have one output folder.');
                        }

                        outputFolder = process.argv[i];

                        if (!fs.pathExistsSync(outputFolder)) {
                            throw new UsageError('Output folder path does not exist.');
                        }

                        if (!fs.lstatSync(outputFolder).isDirectory()) {
                            throw new UsageError('Output folder path is not a folder.');
                        }

                        break;
                    case '--wonderland-path':
                        i++;
                        if (i >= process.argv.length) {
                            throw new UsageError('Expected path or executable name after --wonderland-path argument, found nothing.');
                        }

                        if (wonderlandPath !== null) {
                            throw new UsageError('Can only have one Wonderland Engine editor path.');
                        }

                        wonderlandPath = process.argv[i];
                        break;
                    case '--projects-only':
                        projectsOnly = true;
                        break;
                    case '--template-project-path':
                        i++;
                        if (i >= process.argv.length) {
                            throw new UsageError('Expected path after --template-project-path argument, found nothing.');
                        }

                        if (templateProject !== null) {
                            throw new UsageError('Can only have one template project.');
                        }

                        templateProject = process.argv[i];
                        break;
                    case '--version':
                        if (i + 3 >= process.argv.length) {
                            throw new UsageError(`Expected a 3 numbers after --version argument, found ${process.argv.length - i - 1}.`);
                        }

                        const major = Number(process.argv[++i]);
                        const minor = Number(process.argv[++i]);
                        const patch = Number(process.argv[++i]);

                        if (isNaN(major) || major < 0 || isNaN(minor) || minor < 0 || isNaN(patch) || patch < 0) {
                            throw new UsageError('Version numbers must be valid positive numbers.');
                        }

                        version = [major, minor, patch];

                        break;
                    case '--use-links':
                    case '--use-symlinks':
                        useLinks = true;
                        break;
                    case '--no-links':
                        useLinks = false;
                        break;
                    case '--keep-other-resources':
                        keepOtherResources = true;
                        break;
                    case '--help':
                    case '-h':
                        printHelp();
                        return;
                    default:
                        throw new UsageError(`Unknown argument: "${arg}"`);
                }
            } else if(mark === 1) {
                let modelPath = arg;

                if (!fs.existsSync(modelPath)) {
                    throw new UserError(`Input model path does not exist: "${modelPath}".`);
                }

                const modelStat = fs.lstatSync(modelPath);
                if (modelStat.isFile()) {
                    addInputModel(models, modelPath);
                } else if(modelStat.isDirectory()) {
                    for (const dirFileName of fs.readdirSync(modelPath)) {
                        const dirFilePath = path.join(modelPath, dirFileName);
                        const dirFileStat = fs.lstatSync(dirFilePath);

                        if (dirFileStat.isFile() && (dirFileName.endsWith('.gltf') || dirFileName.endsWith('.glb'))) {
                            addInputModel(models, dirFilePath);
                        }
                    }
                } else {
                    throw new UserError(`Unexpected input model path type for "${modelPath}": must be either a file or a folder.`);
                }
            } else {
                wonderlandArgs.push(arg);
            }
        }

        if (outputFolder === null) {
            outputFolder = process.cwd();
        }

        if(wonderlandPath === null) {
            if(onWindows)
                wonderlandPath = defaultWindowsWLPath;
            else
                wonderlandPath = defaultWLBin;
        }

        if (templateProject === null) {
            // TODO try to find empty template project and parse it
            throw new UserError('No template project specified');
        }

        if (mark === 0 && models.length === 0) {
            const cwd = process.cwd();
            const defaultGLTFPath = path.join(cwd, 'model.gltf');
            const defaultGLBPath = path.join(cwd, 'model.glb');

            if (fs.existsSync(defaultGLTFPath) && fs.lstatSync(defaultGLTFPath).isFile()) {
                addInputModel(models, defaultGLTFPath);
            } else if (fs.existsSync(defaultGLBPath) && fs.lstatSync(defaultGLBPath).isFile()) {
                addInputModel(models, defaultGLBPath);
            } else {
                throw new UserError('No model available in current working directory. Must be either in "model.gltf" or "model.glb".');
            }
        }

        if (models.length === 0) {
            throw new UserError('No model files specified.');
        }

        if (version === null) {
            // no version provided. auto-detected
            version = await detectVersion(wonderlandPath);
        }

        for (const {modelPath, modelFileName, outputName} of models) {
            const neoProject = await generateProject(templateProject, version, keepOtherResources);

            let tempProjDir: string;
            if (projectsOnly) {
                tempProjDir = outputFolder;
            } else {
                // make temporary folder for project
                tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), wlProjectName));
                if (tmpDir === null) {
                    throw new UserError('Could not creat temporary directory');
                }

                tempProjDir = tmpDir;
            }

            // make link in temporary folder for model file; wonderland engine
            // doesn't seem to support absolute paths anymore
            const fullModelPath = path.resolve(modelPath);
            const linkPath = path.join(tempProjDir, modelFileName);

            linkOrCopy(onWindows, useLinks, fullModelPath, linkPath);

            // link/copy package.json for dummy project
            const dummyPackageSrc = path.join(__dirname, 'dummy-package.json');
            const dummyPackageDst = path.join(tempProjDir, 'package.json');
            linkOrCopy(onWindows, useLinks, dummyPackageSrc, dummyPackageDst);

            // compile model
            // save project file to temp folder
            const projectPath = path.join(tempProjDir, `${outputName}.wlp`);
            console.info(`Saving project file "${projectPath}"`);
            await neoProject.writeToFile(projectPath);

            if (!projectsOnly) {
                // import and compile model to bin
                await importPackageProject(projectPath, tempProjDir, wonderlandPath, wonderlandArgs, linkPath);
                return;

                // move compiled model to destination
                console.info('Done compiling. Moving to output folder...')
                const src = path.join(tempProjDir, 'deploy', `${wlProjectName}.bin`);
                const dst = path.join(outputFolder, outputName);
                fs.moveSync(src, dst, { overwrite: true });

                // remove temporary folder
                removeTmpDir();
            }
        }
    } catch(e) {
        if (e instanceof UserError) {
            console.error(`${e.message}\n`);

            if (e instanceof UsageError) {
                printHelp();
            }
        } else {
            throw e;
        }
    } finally {
        // removeTmpDir();
    }
}

process.on('SIGINT', () => {
    console.error('Interrupted! Cleaning up temporary directory and stopping child process...');

    if (childProc !== null) {
        childProc.kill();
    }

    removeTmpDir();

    process.exit(1);
});

exports.gltfToWlBin = main;