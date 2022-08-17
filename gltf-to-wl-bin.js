const gltfPipeline = require('gltf-pipeline');
const { spawn } = require('node:child_process');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('path');

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
        if(this._path === null) {
            let name = this.name;

            if(name === null) {
                const childNumber = this.parent.children.indexOf(this);

                if(childNumber < 0)
                    throw new Error('Node not present in parent');

                name = `object_${childNumber}`;
            }

            this._path = `${name}${this.parent.id === null ? '' : `<${this.parent.path}`}`;
        }

        return this._path;
    }

    reverse() {
        for(let i = 0; i < Math.floor(this.children.length / 2); i++) {
            const first = this.children[i];
            const second = this.children[this.children.length - i - 1];

            for(const firstChild of first.children)
                firstChild.parent = second;

            for(const secondChild of second.children)
                secondChild.parent = first;

            [first.children, second.children] = [second.children, first.children];
        }

        // XXX only the root of the tree is reversed for some reason
        // for(const child of this.children)
        //     child.reverse();
    }

    dfs(callback) {
        for(const child of this.children) {
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

        if(this.parent.id !== null)
            object.parent = this.parent.id.toString();

        if(this.skin !== null)
            object.skin = this.skin.toString();

        const components = [];

        if(this.meshSkin !== null) {
            components.push({
                mesh: { skin: this.meshSkin.toString() }
            });
        }

        if(components.length !== 0)
            object.components = components;

        return object;
    }
}

function generateProject(origFilePath, ratio, json) {
    console.info(`Generating project from model file "${origFilePath}" with ${ratio === 1 ? 'no' : ratio} mesh simplification...`);

    // fs.writeFileSync('gltf-dump.json', JSON.stringify(json, null, 4));
    // return;

    const objects = {};
    const meshes = {};
    const textures = {};
    const images = {};
    const materials = {};
    const animations = {};
    const skins = {};
    let id = 28;

    const project = {
        objects,
        meshes,
        textures,
        images,
        materials,
        shaders: {
            "1": {
                "link": {
                    "name": "Depth.frag",
                    "file": "default"
                }
            },
            "3": {
                "link": {
                    "name": "DistanceFieldVector.frag",
                    "file": "default"
                }
            },
            "5": {
                "link": {
                    "name": "Dynamic.vert",
                    "file": "default"
                }
            },
            "6": {
                "link": {
                    "name": "Flat.frag",
                    "file": "default"
                }
            },
            "9": {
                "link": {
                    "name": "MeshVisualizer.frag",
                    "file": "default"
                }
            },
            "11": {
                "link": {
                    "name": "Phong.frag",
                    "file": "default"
                }
            },
            "14": {
                "link": {
                    "name": "Physical.frag",
                    "file": "default"
                }
            },
            "17": {
                "link": {
                    "name": "Skinning.vert",
                    "file": "default"
                }
            },
            "18": {
                "link": {
                    "name": "Sky.frag",
                    "file": "default"
                }
            },
            "19": {
                "link": {
                    "name": "Sky.vert",
                    "file": "default"
                }
            },
            "20": {
                "link": {
                    "name": "Text.frag",
                    "file": "default"
                }
            },
            "22": {
                "link": {
                    "name": "Text.vert",
                    "file": "default"
                }
            },
            "23": {
                "link": {
                    "name": "TileFeedback.frag",
                    "file": "default"
                }
            },
            "24": {
                "link": {
                    "name": "Particle.frag",
                    "file": "default"
                }
            }
        },
        animations,
        skins,
        pipelines: {
            "2": {
                "link": {
                    "name": "Depth",
                    "file": "default"
                }
            },
            "4": {
                "link": {
                    "name": "DistanceFieldVector",
                    "file": "default"
                }
            },
            "7": {
                "link": {
                    "name": "Flat Opaque",
                    "file": "default"
                }
            },
            "8": {
                "link": {
                    "name": "Flat Opaque Textured",
                    "file": "default"
                }
            },
            "10": {
                "link": {
                    "name": "MeshVisualizer",
                    "file": "default"
                }
            },
            "12": {
                "link": {
                    "name": "Phong Opaque",
                    "file": "default"
                }
            },
            "13": {
                "link": {
                    "name": "Phong Opaque Textured",
                    "file": "default"
                }
            },
            "15": {
                "link": {
                    "name": "Physical Opaque",
                    "file": "default"
                }
            },
            "16": {
                "link": {
                    "name": "Physical Opaque Textured",
                    "file": "default"
                }
            },
            "21": {
                "link": {
                    "name": "Text",
                    "file": "default"
                }
            },
            "25": {
                "link": {
                    "name": "Foliage",
                    "file": "default"
                }
            },
            "26": {
                "link": {
                    "name": "Particle",
                    "file": "default"
                }
            },
            "27": {
                "link": {
                    "name": "Sky",
                    "file": "default"
                }
            }
        },
        settings: {
            project: {
                name: wlProjectName,
                version: [0, 8, 10],
                packageForStreaming: true
            }
        },
        files: [origFilePath]
    }

    // generate skins
    const skinsMap = new Map();
    const skinsJoints = new Map();
    const jointIdxs = new Map();
    if('skins' in json) {
        let skinID = 0;
        for(const skin of json.skins) {
            const jointsArray = [];
            skins[id.toString()] = {
                link: {
                    name: skin.name,
                    file: origFilePath
                },
                joints: jointsArray
            };

            // XXX joints added to array later when the scene objects tree is ready
            for(const jointIdx of skin.joints)
                jointIdxs.set(jointIdx, id);

            skinsMap.set(skinID, id);
            skinsJoints.set(id, jointsArray);

            id++;
            skinID++;
        }
    }

    // generate scene objects tree
    const tree = new Node(true);
    if('nodes' in json) {
        const nodeCount = json.nodes.length;

        {
            const idxs = Array.from(Array(nodeCount).keys());
            const nodesFlat = idxs.map(_i => new Node());
            const orphans = new Set(idxs);

            let idx = 0;
            for(const nodeObj of json.nodes) {
                const node = nodesFlat[idx];

                if('name' in nodeObj)
                    node.name = nodeObj.name;

                if('children' in nodeObj) {
                    for(const childIdx of nodeObj.children) {
                        nodesFlat[childIdx].setParent(node);
                        orphans.delete(childIdx);
                    }
                }

                if('skin' in nodeObj)
                    node.meshSkin = skinsMap.get(nodeObj.skin);

                const skinID = jointIdxs.get(idx);
                if(skinID !== undefined)
                    node.skin = skinID;

                idx++;
            }

            const orphansOrdered = Array.from(orphans);
            orphansOrdered.sort();

            for(const orphanIdx of orphansOrdered)
                nodesFlat[orphanIdx].setParent(tree);
        }

        // node children need to be reversed for some reason
        tree.reverse();

        // add each node to objects list in depth-first order
        tree.dfs(node => {
            node.id = id;

            if(node.skin !== null)
                skinsJoints.get(node.skin).push(id);

            objects[id.toString()] = node.toJson(origFilePath);
            id++;
        });
    }

    // generate meshes list
    if('meshes' in json) {
        for(const mesh of json.meshes) {
            meshObj = {
                link: {
                    name: mesh.name,
                    file: origFilePath
                }
            };

            if(ratio !== 1) {
                meshObj.simplify = true;
                meshObj.simplifyTarget = ratio;
            }

            meshes[id.toString()] = meshObj;

            id++;
        }
    }

    // generate materials list
    if('materials' in json) {
        for(const material of json.materials) {
            materials[id.toString()] = {
                link: {
                    name: material.name,
                    file: origFilePath
                }
            }

            id++;
        }
    }

    // generate animations list
    if('animations' in json) {
        for(const animation of json.animations) {
            animations[id.toString()] = {
                link: {
                    name: animation.name,
                    file: origFilePath
                }
            }

            id++;
        }
    }

    // generate images list
    if('images' in json) {
        for(const image of json.images) {
            images[id.toString()] = {
                link: {
                    name: image.name,
                    file: origFilePath
                }
            }

            id++;
        }
    }

    // generate textures list
    if('textures' in json) {
        for(const texture of json.textures) {
            textures[id.toString()] = {
                link: {
                    name: `texture_${texture.source}`,
                    file: origFilePath
                }
            }

            id++;
        }
    }

    const projectPath = path.join(tmpDir, `${wlProjectName}.wlp`);
    fs.writeFileSync(projectPath, JSON.stringify(project, null, 4));
    console.info(`Generated project file "${projectPath}"`);

    return projectPath;
}

async function loadGLTF(path, ratio) {
    if(!fs.existsSync(path))
        throw new UserError(`File not found: "${path}".`);

    const lowPath = path.toLowerCase();
    if(lowPath.endsWith('.gltf'))
        return generateProject(path, ratio, fs.readJsonSync(path));
    else if(lowPath.endsWith('.glb')) {
        console.info(`Temporarily converting GLB model "${path}" to GLTF...`);

        const results = await gltfPipeline.glbToGltf(fs.readFileSync(path));
        return generateProject(path, ratio, results.gltf);
    }
    else
        throw new UserError('Unknown file extension. Must be either ".gltf" or ".glb"');
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
- Compiles a selection of models in the "models" folder with 50% mesh simplification, except a low-poly tree model, which has no mesh simplification. Outputs to a "static/bins" folder.

Available arguments:
- --default-simplification <default_simplification_target>: Denotes the default simplification_target value applied to each model file that has no simplification_target set. 1 by default.
- --output-folder <output_folder_path>: The folder where all the generated .bin files will be put. Uses the current directory by default.
- --wonderland-path <wonderland_editor_executable_path>: The path to the Wonderland Engine editor (a simple executable name instead of a path works too). If not specified, then "WonderlandEditor" will be used as the executable.

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
        if(tmpDir !== null) {
            fs.rmSync(tmpDir, { recursive: true });
            tmpDir = null;
        }
    }
    catch(e) {
        console.error(`Failed to remove temporary directory "${tmpDir}". Please manually remove it.`);
        throw e;
    }
}

function compileModel(projectPath, wonderlandPath, wonderlandArgs) {
    return new Promise((resolve, reject) => {
        console.info('Compiling to bin model...');

        const args = ['--project', projectPath, '--package', '--windowless', ...wonderlandArgs];

        console.info('Spawning process:', wonderlandPath, ...args);

        const child = spawn(wonderlandPath, args, {
            cwd: tmpDir,
            windowsHide: true
        });

        let done = false;
        child.on('exit', (code, signal) => {
            if(done)
                return;

            done = true;

            if(code === 0)
                resolve();
            else
                reject(new UserError(`bin compilation failed; Wonderland Engine editor exited with code ${code} and signal ${signal}.`));
        });

        child.on('error', (err) => {
            if(done)
                return;

            done = true;

            reject(err);
        });

        child.stderr.pipe(process.stdout);
        child.stderr.pipe(process.stderr);
    });
}

async function main() {
    try {
        // parse arguments
        let models = [];
        let defaultSimplificationRatio = null;
        let outputFolder = null;
        let wonderlandArgs = [];
        let mark = 0;
        let wonderlandPath = null;

        for(let i = 2; i < process.argv.length; i++) {
            const arg = process.argv[i];

            if(mark === 0) {
                switch(arg) {
                    case '--':
                        mark = 1;
                        break;
                    case '--output-folder':
                        i++;
                        if(i >= process.argv.length)
                            throw new UsageError('Expected path after --output-folder argument, found nothing.');

                        if(outputFolder !== null)
                            throw new UsageError('Can only have one output folder.');

                        outputFolder = process.argv[i];

                        if(!fs.pathExistsSync(outputFolder))
                            throw new UsageError('Output folder path does not exist.');

                        if(!fs.lstatSync(outputFolder).isDirectory())
                            throw new UsageError('Output folder path is not a folder.');

                        break;
                    case '--default-simplification':
                        i++;
                        if(i >= process.argv.length)
                            throw new UsageError('Expected simplification target after --default-simplification argument, found nothing.');

                        if(defaultSimplificationRatio !== null)
                            throw new UsageError('Can only have one default simplification target.');

                        defaultSimplificationRatio = Number(process.argv[i]);

                        if(isNaN(defaultSimplificationRatio))
                            throw new UsageError('Default simplification target must be a valid number.');

                        break;
                    case '--wonderland-path':
                        i++;
                        if(i >= process.argv.length)
                            throw new UsageError('Expected path or executable name after --wonderland-path argument, found nothing.');

                        if(wonderlandPath !== null)
                            throw new UsageError('Can only have one Wonderland Engine editor path.');

                        wonderlandPath = process.argv[i];
                        break;
                    case '--help':
                    case '-h':
                        printHelp();
                        return;
                    default:
                        throw new UsageError(`Unknown argument: "${arg}"`);
                }
            }
            else if(mark === 1) {
                let modelPath;
                let ratio = null;
                if(arg.indexOf(':') === -1)
                    modelPath = arg;
                else {
                    const parts = arg.split(':', 2);
                    if(parts[0] === '' || parts[1] === '')
                        throw new UsageError(`Invalid input model file argument: "${arg}".`);

                    if(parts[0] !== 'default') {
                        ratio = Number(parts[0]);

                        if(isNaN(ratio))
                            throw new UsageError(`Invalid input model file simplification target: "${arg}". Simplification target must be "default" or a number.`);
                    }

                    modelPath = parts[1];
                }

                const modelFileName = path.basename(modelPath);
                const modelExt = path.extname(modelFileName);

                let outputName;
                const extLen = modelExt.length;
                if(extLen > 0)
                    outputName = modelFileName.substring(0, modelFileName.length - extLen) + '.bin';
                else
                    outputName = modelFileName + '.bin';

                for(const { modelPath: oModelPath, ratio: _oRatio, outputName: oName } of models) {
                    if(oName === outputName)
                        throw new UsageError(`Multiple model files have the same name (excluding the extension): "${oModelPath}" and "${modelPath}". Please rename files that share this name.`);
                }

                models.push({ modelPath, ratio, outputName });
            }
            else
                wonderlandArgs.push(arg);
        }

        if(defaultSimplificationRatio === null)
            defaultSimplificationRatio = 1;

        if(outputFolder === null)
            outputFolder = process.cwd();

        if(wonderlandPath === null)
            wonderlandPath = 'WonderlandEditor';

        if(mark === 0 && models.length === 0) {
            const cwd = process.cwd();
            const defaultGLTFPath = path.join(cwd, 'model.gltf');
            const defaultGLBPath = path.join(cwd, 'model.glb');

            if(fs.existsSync(defaultGLTFPath) && fs.lstatSync(defaultGLTFPath).isFile())
                models.push(defaultGLTFPath);
            else if(fs.existsSync(defaultGLBPath) && fs.lstatSync(defaultGLBPath).isFile())
                models.push(defaultGLBPath);
            else
                throw new UserError('No model available in current working directory. Must be either in "model.gltf" or "model.glb".');
        }

        if(models.length === 0)
            throw new UserError('No model files specified.');

        for(const {modelPath, ratio, outputName} of models) {
            // make temporary folder for project
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), wlProjectName));

            // generate project for model
            const actualRatio = ratio === null ? defaultSimplificationRatio : ratio;
            const fullModelPath = path.resolve(modelPath);
            const projectPath = await loadGLTF(fullModelPath, actualRatio);

            // compile model
            await compileModel(projectPath, wonderlandPath, wonderlandArgs);

            // move compiled model to destination
            console.info('Done compiling. Moving to output folder...')
            const src = path.join(tmpDir, 'deploy', `${wlProjectName}.bin`);
            const dst = path.join(outputFolder, outputName);
            fs.moveSync(src, dst, { overwrite: true });

            // remove temporary folder
            removeTmpDir();
        }
    }
    catch(e) {
        if(e instanceof UserError) {
            console.error(`${e.message}\n`);
            printHelp();
        }
        else
            throw e;
    }
    finally {
        removeTmpDir();
    }
}

main();