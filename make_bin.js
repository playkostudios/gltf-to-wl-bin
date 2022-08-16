const gltfPipeline = require('gltf-pipeline');
const fs = require('fs-extra');

const projectName = 'output';
const outputProjectPath = `./${projectName}.wlp`;

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

function generateProject(origFilePath, json) {
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
                name: projectName,
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
            meshes[id.toString()] = {
                link: {
                    name: mesh.name,
                    file: origFilePath
                }
            }

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

    fs.writeFileSync(outputProjectPath, JSON.stringify(project, null, 4));
    console.log(`Generated project file "${outputProjectPath}"`);
}

async function loadGLTF(path) {
    console.log(`Making project from model file "${path}"...`);

    if(!fs.existsSync(path))
        throw new Error('File not found.');

    const lowPath = path.toLowerCase();
    if(lowPath.endsWith('.gltf'))
        generateProject(path, fs.readJsonSync(path));
    else if(lowPath.endsWith('.glb')) {
        const results = await gltfPipeline.glbToGltf(fs.readFileSync(path));
        generateProject(path, results.gltf);
    }
    else
        throw new Error('Unknown file extension. Must be either ".gltf" or ".glb"');
}

function loadDefaultGLTF() {
    const gltfPath = 'model.gltf';
    const glbPath = 'model.glb';

    if(fs.existsSync(gltfPath))
        loadGLTF(gltfPath);
    else if(fs.existsSync(glbPath))
        loadGLTF(glbPath);
    else
        throw new Error('No model available in default location. Must be either in "model.gltf" or "model.glb"');
}

if(process.argv.length === 2)
    loadDefaultGLTF();
else if(process.argv.length === 3)
    loadGLTF(process.argv[2]);
else
    throw new Error(`Invalid usage. Usage: ${process.argv[0]} <model_file>`);