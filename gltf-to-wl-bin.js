const { spawn } = require('node:child_process');
const gltfPipeline = require('gltf-pipeline');
const stream = require('node:stream');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('path');

const defaultWLBin = 'WonderlandEditor';
const defaultWindowsWLPath = `C:\\Program Files\\Wonderland\\WonderlandEngine\\bin\\${defaultWLBin}.exe`;
const wlProjectName = 'gltf-to-wl-bin';
let tmpDir = null;

class Node {
    constructor(root = false) {
        this.children = [];
        this.parent = null;
        this.name = null;
        this._path = root ? '' : null;
        this.id = null;
        this.meshSkin = null;
        this.skin = null;
    }

    setParent(parent) {
        this.parent = parent;
        parent.children.push(this);
    }

    get path() {
        if (this._path === null) {
            let name = this.name;

            if (name === null) {
                const childNumber = this.parent.children.indexOf(this);

                if (childNumber < 0) {
                    throw new Error('Node not present in parent');
                }

                name = `object_${childNumber}`;
            }

            this._path = `${name}${this.parent.id === null ? '' : `<${this.parent.path}`}`;
        }

        return this._path;
    }

    reverse() {
        for (let i = 0; i < Math.floor(this.children.length / 2); i++) {
            const first = this.children[i];
            const second = this.children[this.children.length - i - 1];

            for (const firstChild of first.children) {
                firstChild.parent = second;
            }

            for (const secondChild of second.children) {
                secondChild.parent = first;
            }

            [first.children, second.children] = [second.children, first.children];
        }

        // XXX only the root of the tree is reversed for some reason
        // for(const child of this.children)
        //     child.reverse();
    }

    dfs(callback) {
        for (const child of this.children) {
            callback(child);
            child.dfs(callback);
        }
    }

    toJson(origFilePath) {
        const object = {
            link: {
                name: this.path,
                file: origFilePath
            }
        }

        if (this.parent.id !== null) {
            object.parent = this.parent.id.toString();
        }

        if (this.skin !== null) {
            object.skin = this.skin.toString();
        }

        const components = [];

        if (this.meshSkin !== null) {
            components.push({
                mesh: { skin: this.meshSkin.toString() }
            });
        }

        if (components.length !== 0) {
            object.components = components;
        }

        return object;
    }
}

function legacyGenerateProject(origFilePath, symlinkRelPath, outputName, tempProjDir, ratio, curID, templateProject, version, keepOtherResources, json) {
    console.info(`Generating project from model file "${origFilePath}" with ${ratio === 1 ? 'no' : ratio} mesh simplification...`);

    // fs.writeFileSync('gltf-dump.json', JSON.stringify(json, null, 4));

    const project = generateBaseProject(templateProject, version, keepOtherResources);
    project.files.push(symlinkRelPath);
    let id = curID;

    // generate images list
    let imgDefaultNum = 0;
    if ('images' in json) {
        for (const image of json.images) {
            let name = image.name;

            if (!name) {
                name = `image_${imgDefaultNum}`;
                imgDefaultNum++;
            }

            project.images[id.toString()] = {
                link: {
                    name,
                    file: symlinkRelPath
                }
            }

            id++;
        }
    }

    // generate textures list
    const texSources = new Set();
    let texCount = 0;
    if ('textures' in json) {
        for (const texture of json.textures) {
            if (!texSources.has(texture.source)) {
                project.textures[id.toString()] = {
                    link: {
                        name: `texture_${texCount}`,
                        file: symlinkRelPath
                    }
                }

                id++;
                texSources.add(texture.source);
            }

            texCount++;
        }
    }

    // generate materials list
    let matDefaultNum = 0;
    if ('materials' in json) {
        for (const material of json.materials) {
            let name = material.name;

            if (!name) {
                name = `material_${matDefaultNum}`;
                matDefaultNum++;
            }

            project.materials[id.toString()] = {
                link: {
                    name,
                    file: symlinkRelPath
                }
            }

            id++;
        }
    }

    // generate meshes list
    let meshDefaultNum = 0;
    if ('meshes' in json) {
        for (const mesh of json.meshes) {
            let name = mesh.name;

            if (!name) {
                name = `mesh_${meshDefaultNum}`;
                meshDefaultNum++;
            }

            meshObj = {
                link: {
                    name,
                    file: symlinkRelPath
                }
            };

            if (ratio !== 1) {
                meshObj.simplify = true;
                meshObj.simplifyTarget = ratio;
            }

            project.meshes[id.toString()] = meshObj;

            id++;
        }
    }

    // generate skins
    let skinDefaultNum = 0;
    const skinsMap = new Map();
    const skinsJoints = new Map();
    const jointIdxs = new Map();
    if ('skins' in json) {
        let skinID = 0;
        for (const skin of json.skins) {
            let name = skin.name;

            if (!name) {
                name = `skin_${skinDefaultNum}`;
                skinDefaultNum++;
            }

            const jointsArray = [];
            project.skins[id.toString()] = {
                link: {
                    name,
                    file: symlinkRelPath
                },
                joints: jointsArray
            };

            // XXX joints added to array later when the scene objects tree is ready
            for (const jointIdx of skin.joints) {
                jointIdxs.set(jointIdx, id);
            }

            skinsMap.set(skinID, id);
            skinsJoints.set(id, jointsArray);

            id++;
            skinID++;
        }
    }

    // generate scene objects tree
    const tree = new Node(true);
    if ('nodes' in json) {
        const nodeCount = json.nodes.length;

        {
            const idxs = Array.from(Array(nodeCount).keys());
            const nodesFlat = idxs.map(_i => new Node());
            const orphans = new Set(idxs);

            let idx = 0;
            for (const nodeObj of json.nodes) {
                const node = nodesFlat[idx];

                if ('name' in nodeObj) {
                    node.name = nodeObj.name;
                }

                if ('children' in nodeObj) {
                    for (const childIdx of nodeObj.children) {
                        nodesFlat[childIdx].setParent(node);
                        orphans.delete(childIdx);
                    }
                }

                if ('skin' in nodeObj) {
                    node.meshSkin = skinsMap.get(nodeObj.skin);
                }

                const skinID = jointIdxs.get(idx);
                if (skinID !== undefined) {
                    node.skin = skinID;
                }

                idx++;
            }

            const orphansOrdered = Array.from(orphans);
            orphansOrdered.sort();

            for (const orphanIdx of orphansOrdered) {
                nodesFlat[orphanIdx].setParent(tree);
            }
        }

        // node children need to be reversed for some reason
        tree.reverse();

        // add each node to objects list in depth-first order
        tree.dfs(node => {
            node.id = id;

            if (node.skin !== null) {
                skinsJoints.get(node.skin).push(id.toString());
            }

            project.objects[id.toString()] = node.toJson(symlinkRelPath);
            id++;
        });
    }

    // generate animations list
    let animDefaultNum = 0;
    if ('animations' in json) {
        for (const animation of json.animations) {
            // XXX not sure if a default name is necessary for animations, but
            // just in case
            let name = animation.name;

            if (!name) {
                name = `animation_${animDefaultNum}`;
                animDefaultNum++;
            }

            project.animations[id.toString()] = {
                link: {
                    name,
                    file: symlinkRelPath
                }
            }

            id++;
        }
    }

    const projectPath = writeProject(project, outputName, tempProjDir);

    return [projectPath, id];
}

async function legacyLoadGLTF(path, symlinkRelPath, outputName, tempProjDir, ratio, curID, templateProject, version, keepOtherResources) {
    if (!fs.existsSync(path)) {
        throw new UserError(`File not found: "${path}".`);
    }

    const lowPath = path.toLowerCase();
    if (lowPath.endsWith('.gltf')) {
        return legacyGenerateProject(path, symlinkRelPath, outputName, tempProjDir, ratio, curID, templateProject, version, keepOtherResources, fs.readJsonSync(path));
    } else if(lowPath.endsWith('.glb')) {
        console.info(`Temporarily converting GLB model "${path}" to GLTF...`);

        const results = await gltfPipeline.glbToGltf(fs.readFileSync(path), { keepUnusedElements: true });
        return legacyGenerateProject(path, symlinkRelPath, outputName, tempProjDir, ratio, curID, templateProject, version, keepOtherResources, results.gltf);
    } else {
        throw new Error(`Unexpected file extension in "${lowPath}". Extensions should be filtered by now.`);
    }
}

function finalizeBin(outputName, outputFolder, tempProjDir) {
    // move compiled model to destination
    console.info('Done compiling. Moving to output folder...')
    const src = path.join(tempProjDir, 'deploy', `${wlProjectName}.bin`);
    const dst = path.join(outputFolder, outputName);
    fs.moveSync(src, dst, { overwrite: true });

    // remove temporary folder
    removeTmpDir();
}

async function legacyCompileModel(fullModelPath, modelFileName, actualRatio, outputName, outputFolder, tempProjDir, projectsOnly, curID, templateProject, version, keepOtherResources, wonderlandPath, wonderlandArgs) {
    // load gltf into temporary project file
    let projectPath;
    [projectPath, curID] = await legacyLoadGLTF(fullModelPath, modelFileName, outputName, tempProjDir, actualRatio, curID, templateProject, version, keepOtherResources);

    if (!projectsOnly) {
        // compile model to bin
        await packageProject(projectPath, tempProjDir, wonderlandPath, wonderlandArgs);

        // finalize compiled bin
        finalizeBin(outputName, outputFolder, tempProjDir);
    }
}

function generateBaseProject(templateProject, version, keepOtherResources) {
    const meshes = keepOtherResources ? { ...templateProject.meshes } : {};
    const textures = keepOtherResources ? { ...templateProject.textures } : {};
    const images = keepOtherResources ? { ...templateProject.images } : {};
    const materials = keepOtherResources ? { ...templateProject.materials } : {};

    return {
        objects: {},
        meshes,
        textures,
        images,
        materials,
        shaders: templateProject.shaders,
        animations: {},
        skins: {},
        pipelines: templateProject.pipelines,
        settings: {
            project: {
                name: wlProjectName,
                version,
                packageForStreaming: true
            }
        },
        files: []
    };
}

function writeProject(project, outputName, tempProjDir) {
    const projectPath = path.join(tempProjDir, `${outputName}.wlp`);
    fs.writeFileSync(projectPath, JSON.stringify(project, null, 4));
    console.info(`Saving project file "${projectPath}"`);

    return projectPath;
}

function generateProject(templateProject, version, keepOtherResources) {
    console.info(`Generating actual template project file...`);
    return generateBaseProject(templateProject, version, keepOtherResources);
}

async function compileModel(symlinkPath, actualRatio, outputName, outputFolder, tempProjDir, neoProject, projectsOnly, wonderlandPath, wonderlandArgs) {
    // save project file to temp folder
    const projectPath = writeProject(neoProject, outputName, tempProjDir);

    if (actualRatio !== 1) {
        // TODO support actualRatio when support is added to `--import` option in wl
        // TODO make sure to remove legacyImport force-enable when support is added
        throw new Error(`Wonderland Editor "--import" doesn't support mesh simplification yet`);
    }

    if (!projectsOnly) {
        // import and compile model to bin
        await importPackageProject(projectPath, tempProjDir, wonderlandPath, wonderlandArgs, symlinkPath);

        // finalize compiled bin
        finalizeBin(outputName, outputFolder, tempProjDir);
    }
}

class UserError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UserError';
    }
}

class UsageError extends UserError {
    constructor(message) {
        super(`Invalid usage; ${message}`);
    }
}

function printHelp() {
    const progName = `${process.argv[0]} ${process.argv[1]}`;

    console.log(`\
Usage: ${progName} [--default-simplification <default_simplification_target>] [--output-folder <output_folder_path>] [--wonderland-path <wonderland_editor_executable_path>] [-- [[<simplification_target>:]<model_file>] [[<simplification_target_2>:]<model_file_2>] [...]] [-- <wonderland_editor_args...>]
Optional arguments (or groups of arguments) are denoted by square brackets. Greater/lesser than signs denote a single argument.

Note that, if running from an npm script (npm run ...), then an extra mark (--) at the beginning of the argument list is needed:
$ npm run (script name) -- (actual arguments list...)

Example usage:
$ ${progName} --output-folder static/bins/ -- models/
- Compiles all models in the "models" folder and puts the compiled bin models in the "static/bins" folder.
$ ${progName} --output-folder static/bins/ --default-simplification 0.5 -- models/player.glb models/football.glb 1:models/low_poly_tree.glb
- Compiles a selection of models in the "models" folder with a 0.5 mesh simplification target, except the low-poly tree model, which has no mesh simplification. Outputs to a "static/bins" folder.

Available arguments:
- --default-simplification <default_simplification_target>: Denotes the default simplification_target value applied to each model file that has no simplification_target set. 1 by default.
- --output-folder <output_folder_path>: The folder where all the generated .bin files will be put. Uses the current directory by default.
- --wonderland-path <wonderland_editor_executable_path>: The path to the Wonderland Engine editor (a simple executable name instead of a path works too). If not specified, then "${defaultWindowsWLPath}" will be used as the executable for Windows, and "${defaultWLBin}" will be used for any other OS.
- --projects-only: Only generate project files instead of converting to bin files.
- --template-project-path: A path to an existing project file. The default shader, texture, material, etc... IDs from this project will be used for the generated projects.
- --reserve-ids: The minimum IDs to use for the generated project file. Even if not set, resource IDs for generated projects will never intersect. If a template project is given, then the maximum resource ID will be added to this value. If this value is not set, you may need to re-generate the bin files after adding a new resource or object to the scene of the template project.
- --version <major> <minor> <patch>: The version number to use for the generated project files. If none is supplied, then the current version is detected by running "WonderlandEditor --help".
- --use-symlinks: If passed, then symlinks will be used when building models. Enabled on Linux by default, but not on Windows, since Windows users can't create symlinks without changing group policies.
- --legacy-import: If passed, then streaming template project files will be created manually. Enabled by default for Wonderland Engine versions 0.9.4 and above. Note that models with ".legacy" before their file extension will be forced to use the legacy importer.
- --keep-other-resources: If passed, then project resources other than pipelines and shaders are also kept. Disabled by default.

Available arguments after first mark (--):
- <model_file> or <simplification_target>:<model_file>:
    - simplification_target: When it is a value not equal to 1, then mesh simplification will be applied. If not set, default_simplification_target is used. Note that "default" can be used to keep the default simplification target. This provides a canonical way to do input model files so that an OS which allows ":" in file names, like Linux, doesn't have issues.
    - model_file: The path to the model file that needs to be compiled. If this is a path to a folder, then the folder will be scanned non-recursively for GLTF/GLB files.

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

let childProc = null;

function spawnWLE(workingDir, wonderlandPath, wonderlandArgs, pipeStdout = null, pipeStderr = null) {
    if (pipeStdout === null) {
        pipeStdout = process.stdout;
    }

    if (pipeStderr === null) {
        pipeStderr = process.stderr;
    }

    console.info('Spawning process:', wonderlandPath, ...wonderlandArgs);

    return new Promise((resolve, reject) => {
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

        childProc.stdout.pipe(pipeStdout);
        childProc.stderr.pipe(pipeStderr);
    });
}

class StringStream extends stream.Writable {
    constructor(opts) {
        super(opts);

        this.strParts = [];
    }

    _write(chunk, _enc, next) {
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

async function detectVersion(wonderlandPath) {
    // TODO replace this with a --version query if it ever gets implemented in
    // the editor CLI

    console.info('Detecting Wonderland Engine version...');

    try {
        let outStr;
        {
            const outStream = new StringStream();

            await spawnWLE(
                process.cwd(),
                wonderlandPath,
                ['--help'],
                outStream
            );

            outStr = outStream.toString();
        }

        const versionRegex = /Wonderland Engine ([0-9]+)\.([0-9]+)\.([0-9]+)/g;
        const matches = versionRegex.exec(outStr);

        if (matches.length !== 4) {
            throw new UserError('Could not find version string in help command.');
        }

        const version = [Number(matches[1]), Number(matches[2]), Number(matches[3])];

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

async function packageProject(projectPath, workingDir, wonderlandPath, wonderlandArgs) {
    console.info('Compiling to bin model (legacy)...');

    try {
        await spawnWLE(
            workingDir,
            wonderlandPath,
            ['--project', projectPath, '--package', '--windowless', ...wonderlandArgs]
        );
    } catch(e) {
        if (e instanceof UserError) {
            throw new UserError(`bin compilation failed; ${e.message}`);
        } else {
            throw e;
        }
    }
}

async function importPackageProject(projectPath, workingDir, wonderlandPath, wonderlandArgs, modelPath) {
    console.info('Compiling to bin model...');

    try {
        await spawnWLE(
            workingDir,
            wonderlandPath,
            ['--import', modelPath, '--project', projectPath, '--package', '--windowless', ...wonderlandArgs]
        );
    } catch(e) {
        if (e instanceof UserError) {
            throw new UserError(`bin compilation failed; ${e.message}`);
        } else {
            throw e;
        }
    }
}

function addInputModel(models, modelPath, ratio) {
    const modelFileName = path.basename(modelPath);
    const modelExt = path.extname(modelFileName);
    const extLen = modelExt.length;
    if (extLen === 0 || (modelExt !== '.gltf' && modelExt !== '.glb')) {
        throw new UserError(`Unknown file extension for path "${modelPath}". Must be either ".gltf" or ".glb"`);
    }

    let baseFileName = modelFileName.substring(0, modelFileName.length - extLen);
    let legacyImport = false;
    if (baseFileName.endsWith('.legacy')) {
        legacyImport = true;
        baseFileName = baseFileName.substring(0, baseFileName.length - 7);
    }

    let outputName = baseFileName + '.bin';

    for (const { modelPath: oModelPath, ratio: _oRatio, outputName: oName, legacyImport: _oLegacyImport } of models) {
        if (oName === outputName) {
            throw new UsageError(`Multiple model files have the same name (excluding the extension): "${oModelPath}" and "${modelPath}". Please rename files that share this name.`);
        }
    }

    models.push({ modelPath, modelFileName, ratio, outputName, legacyImport });
}

function getMaxId(newIDStr, maxID) {
    const idNum = Number(newIDStr);

    if (isNaN(idNum) || idNum <= maxID) {
        return maxID;
    } else {
        return idNum;
    }
}

function maybeAddDefaultObj(outList, idStr, obj) {
    if (typeof obj.link === 'object' && obj.link.file === 'default') {
        outList[idStr] = obj;
    }
}

function parseTemplateProject(projectPath) {
    // load project json
    const content = fs.readFileSync(projectPath);
    const json = JSON.parse(content);

    // grab default IDs and maximum ID
    let maxID = 0;
    const meshes = {};
    const textures = {};
    const images = {};
    const materials = {};
    const shaders = {};
    const pipelines = {};

    if ('objects' in json) {
        for (const [id, _obj] of Object.entries(json.objects)) {
            maxID = getMaxId(id, maxID);
        }
    }

    if ('meshes' in json) {
        for (const [id, obj] of Object.entries(json.meshes)) {
            maxID = getMaxId(id, maxID);
            maybeAddDefaultObj(meshes, id, obj);
        }
    }

    if ('textures' in json) {
        for (const [id, obj] of Object.entries(json.textures)) {
            maxID = getMaxId(id, maxID);
            maybeAddDefaultObj(textures, id, obj);
        }
    }

    if ('images' in json) {
        for (const [id, obj] of Object.entries(json.images)) {
            maxID = getMaxId(id, maxID);
            maybeAddDefaultObj(images, id, obj);
        }
    }

    if ('materials' in json) {
        for (const [id, obj] of Object.entries(json.materials)) {
            maxID = getMaxId(id, maxID);
            maybeAddDefaultObj(materials, id, obj);
        }
    }

    if ('shaders' in json) {
        for (const [id, obj] of Object.entries(json.shaders)) {
            maxID = getMaxId(id, maxID);
            maybeAddDefaultObj(shaders, id, obj);
        }
    }

    if ('animations' in json) {
        for (const [id, _obj] of Object.entries(json.animations)) {
            maxID = getMaxId(id, id, maxID);
        }
    }

    if ('skins' in json) {
        for (const [id, _obj] of Object.entries(json.skins)) {
            maxID = getMaxId(id, id, maxID);
        }
    }

    if ('pipelines' in json) {
        for (const [id, obj] of Object.entries(json.pipelines)) {
            maxID = getMaxId(id, maxID);
            maybeAddDefaultObj(pipelines, id, obj);
        }
    }

    return [{
        meshes,
        textures,
        images,
        materials,
        shaders,
        pipelines
    }, maxID];
}

async function main() {
    try {
        // parse arguments
        const onWindows = process.platform === 'win32';
        let models = [];
        let defaultSimplificationRatio = null;
        let outputFolder = null;
        let wonderlandArgs = [];
        let mark = 0;
        let wonderlandPath = null;
        let projectsOnly = false;
        let templateProject = null;
        let templateMinID = 0;
        let reservedIDs = null;
        let version = null;
        let useSymlinks = !onWindows;
        let wantLegacyImport = false;
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
                    case '--default-simplification':
                        i++;
                        if (i >= process.argv.length) {
                            throw new UsageError('Expected simplification target after --default-simplification argument, found nothing.');
                        }

                        if (defaultSimplificationRatio !== null) {
                            throw new UsageError('Can only have one default simplification target.');
                        }

                        defaultSimplificationRatio = Number(process.argv[i]);

                        if (isNaN(defaultSimplificationRatio)) {
                            throw new UsageError('Default simplification target must be a valid number.');
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

                        [templateProject, templateMinID] = parseTemplateProject(process.argv[i]);
                        break;
                    case '--reserve-ids':
                        i++;
                        if (i >= process.argv.length) {
                            throw new UsageError('Expected a number after --reserve-ids argument, found nothing.');
                        }

                        if (reservedIDs !== null) {
                            throw new UsageError('Can only have one argument for reserved IDs.');
                        }

                        reservedIDs = Number(process.argv[i]);

                        if (isNaN(reservedIDs) || reservedIDs < 0) {
                            throw new UsageError('Reserved IDs count must be a valid positive number.');
                        }

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
                    case '--use-symlinks':
                        useSymlinks = true;
                        break;
                    case '--legacy-import':
                        wantLegacyImport = true;
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
                let modelPath;
                let ratio = null;
                if (arg.indexOf(':') === -1) {
                    modelPath = arg;
                } else {
                    const parts = arg.split(':', 2);
                    if (parts[0] === '' || parts[1] === '') {
                        throw new UsageError(`Invalid input model file argument: "${arg}".`);
                    }

                    if (parts[0] !== 'default') {
                        ratio = Number(parts[0]);

                        if (isNaN(ratio)) {
                            throw new UsageError(`Invalid input model file simplification target: "${arg}". Simplification target must be "default" or a number.`);
                        }
                    }

                    modelPath = parts[1];
                }

                if (!fs.existsSync(modelPath)) {
                    throw new UserError(`Input model path does not exist: "${modelPath}".`);
                }

                const modelStat = fs.lstatSync(modelPath);
                if (modelStat.isFile()) {
                    addInputModel(models, modelPath, ratio);
                } else if(modelStat.isDirectory()) {
                    for (const dirFileName of fs.readdirSync(modelPath)) {
                        const dirFilePath = path.join(modelPath, dirFileName);
                        const dirFileStat = fs.lstatSync(dirFilePath);

                        if (dirFileStat.isFile() && (dirFileName.endsWith('.gltf') || dirFileName.endsWith('.glb'))) {
                            addInputModel(models, dirFilePath, ratio);
                        }
                    }
                } else {
                    throw new UserError(`Unexpected input model path type for "${modelPath}": must be either a file or a folder.`);
                }
            } else {
                wonderlandArgs.push(arg);
            }
        }

        if (defaultSimplificationRatio === null) {
            defaultSimplificationRatio = 1;
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

        if (reservedIDs === null) {
            reservedIDs = 0;
        }

        if (templateProject === null) {
            templateProject = {
                meshes: {
                    "p0": {
                        "link": {
                            "name": "PrimitivePlane",
                            "file": "default"
                        }
                    },
                    "p1": {
                        "link": {
                            "name": "PrimitiveCube",
                            "file": "default"
                        }
                    },
                    "p2": {
                        "link": {
                            "name": "PrimitiveSphere",
                            "file": "default"
                        }
                    },
                    "p3": {
                        "link": {
                            "name": "PrimitiveCone",
                            "file": "default"
                        }
                    },
                    "p4": {
                        "link": {
                            "name": "PrimitiveCylinder",
                            "file": "default"
                        }
                    },
                    "p5": {
                        "link": {
                            "name": "PrimitiveCircle",
                            "file": "default"
                        }
                    },
                },
                textures: {},
                images: {},
                materials: {
                    "DefaultFontMaterial": {
                        "link": {
                            "name": "DefaultFontMaterial",
                            "file": "default"
                        }
                    }
                },
                shaders: {
                    "1": {
                        "link": {
                            "name": "Background.frag",
                            "file": "default"
                        }
                    },
                    "2": {
                        "link": {
                            "name": "Depth.frag",
                            "file": "default"
                        }
                    },
                    "4": {
                        "link": {
                            "name": "DistanceFieldVector.frag",
                            "file": "default"
                        }
                    },
                    "6": {
                        "link": {
                            "name": "Dynamic.vert",
                            "file": "default"
                        }
                    },
                    "7": {
                        "link": {
                            "name": "Flat.frag",
                            "file": "default"
                        }
                    },
                    "10": {
                        "link": {
                            "name": "FullScreenTriangle.vert",
                            "file": "default"
                        }
                    },
                    "11": {
                        "link": {
                            "name": "MeshVisualizer.frag",
                            "file": "default"
                        }
                    },
                    "13": {
                        "link": {
                            "name": "Phong.frag",
                            "file": "default"
                        }
                    },
                    "16": {
                        "link": {
                            "name": "Physical.frag",
                            "file": "default"
                        }
                    },
                    "19": {
                        "link": {
                            "name": "Skinning.vert",
                            "file": "default"
                        }
                    },
                    "20": {
                        "link": {
                            "name": "Sky.frag",
                            "file": "default"
                        }
                    },
                    "21": {
                        "link": {
                            "name": "Text.frag",
                            "file": "default"
                        }
                    },
                    "23": {
                        "link": {
                            "name": "Text.vert",
                            "file": "default"
                        }
                    },
                    "24": {
                        "link": {
                            "name": "TileFeedback.frag",
                            "file": "default"
                        }
                    },
                    "25": {
                        "link": {
                            "name": "Particle.frag",
                            "file": "default"
                        }
                    }
                },
                pipelines: {
                    "3": {
                        "link": {
                            "name": "Depth",
                            "file": "default"
                        }
                    },
                    "5": {
                        "link": {
                            "name": "DistanceFieldVector",
                            "file": "default"
                        }
                    },
                    "8": {
                        "link": {
                            "name": "Flat Opaque",
                            "file": "default"
                        }
                    },
                    "9": {
                        "link": {
                            "name": "Flat Opaque Textured",
                            "file": "default"
                        }
                    },
                    "12": {
                        "link": {
                            "name": "MeshVisualizer",
                            "file": "default"
                        }
                    },
                    "14": {
                        "link": {
                            "name": "Phong Opaque",
                            "file": "default"
                        }
                    },
                    "15": {
                        "link": {
                            "name": "Phong Opaque Textured",
                            "file": "default"
                        }
                    },
                    "17": {
                        "link": {
                            "name": "Physical Opaque",
                            "file": "default"
                        }
                    },
                    "18": {
                        "link": {
                            "name": "Physical Opaque Textured",
                            "file": "default"
                        }
                    },
                    "22": {
                        "link": {
                            "name": "Text",
                            "file": "default"
                        }
                    },
                    "26": {
                        "link": {
                            "name": "Foliage",
                            "file": "default"
                        }
                    },
                    "27": {
                        "link": {
                            "name": "Particle",
                            "file": "default"
                        }
                    },
                    "28": {
                        "link": {
                            "name": "Sky",
                            "file": "default"
                        }
                    }
                }
            };
            templateMinID = 28;
        }

        let curID = reservedIDs + templateMinID + 1;

        if (mark === 0 && models.length === 0) {
            const cwd = process.cwd();
            const defaultGLTFPath = path.join(cwd, 'model.gltf');
            const defaultGLBPath = path.join(cwd, 'model.glb');

            if (fs.existsSync(defaultGLTFPath) && fs.lstatSync(defaultGLTFPath).isFile()) {
                addInputModel(models, defaultGLTFPath, defaultSimplificationRatio);
            } else if (fs.existsSync(defaultGLBPath) && fs.lstatSync(defaultGLBPath).isFile()) {
                addInputModel(models, defaultGLBPath, defaultSimplificationRatio);
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

            // check if legacy import must be used (must be used before 0.9.4)
            if (version[0] === 0 && (version[1] < 9 || (version[1] === 9 && version[2] < 4))) {
                wantLegacyImport = true;
            }
        }

        if (reservedIDs !== 0 && !wantLegacyImport) {
            console.warn('WARNING - legacy import force-enabled; newer editor "--import" argument does not support reserving IDs');
            wantLegacyImport = true;
        }

        let neoProject = null;
        for (const {modelPath, modelFileName, ratio, outputName, legacyImport: isLegacyModel} of models) {
            let legacyImport = isLegacyModel | wantLegacyImport;

            const actualRatio = ratio === null ? defaultSimplificationRatio : ratio;
            if (actualRatio !== 1 && !legacyImport) {
                legacyImport = true;
                console.warn('WARNING - legacy import force-enabled; newer editor "--import" argument does not support mesh simplification');
            }

            if (legacyImport) {
                console.warn('WARNING - using legacy import; project files will be manually generated instead of using the editor "--import" argument');
            } else if (neoProject === null) {
                neoProject = generateProject(templateProject, version, keepOtherResources);
            }

            let tempProjDir;
            if (projectsOnly) {
                tempProjDir = outputFolder;
            } else {
                // make temporary folder for project
                tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), wlProjectName));
                tempProjDir = tmpDir;
            }

            // make symlink in temporary folder for model file; wonderland
            // engine doesn't seem to support absolute paths anymore
            const fullModelPath = path.resolve(modelPath);
            const symlinkPath = path.join(tempProjDir, modelFileName);

            if (useSymlinks) {
                fs.symlinkSync(fullModelPath, symlinkPath);
            } else {
                fs.copySync(fullModelPath, symlinkPath);
            }

            // compile model
            if (legacyImport) {
                await legacyCompileModel(fullModelPath, modelFileName, actualRatio, outputName, outputFolder, tempProjDir, projectsOnly, curID, templateProject, version, keepOtherResources, wonderlandPath, wonderlandArgs);
            } else {
                await compileModel(symlinkPath, actualRatio, outputName, outputFolder, tempProjDir, neoProject, projectsOnly, wonderlandPath, wonderlandArgs);
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
        removeTmpDir();
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