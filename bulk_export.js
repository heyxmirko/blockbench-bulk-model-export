// Bulk Model Export - export many .bbmodel files at once

(function () {

    // ----- Config -----

    const PLUGIN_ID = 'bulk_export';
    const SETTINGS_KEY = 'bulk_export_last_settings';

    // Java models can't go outside this
    const JAVA_MIN = -16;
    const JAVA_MAX = 32;
    const JAVA_SIZE = JAVA_MAX - JAVA_MIN;

    // Minecraft caps display values at these
    const MAX_DISPLAY_TRANSLATION = 80;
    const MAX_DISPLAY_SCALE = 4;

    const DISPLAY_SLOTS = [
        'thirdperson_righthand', 'thirdperson_lefthand',
        'firstperson_righthand', 'firstperson_lefthand',
        'gui', 'head', 'ground', 'fixed'
    ];

    // If left hand is missing, Minecraft uses the right hand (mirrored)
    const LEFT_HAND_FALLBACK = {
        thirdperson_lefthand: 'thirdperson_righthand',
        firstperson_lefthand: 'firstperson_righthand'
    };

    const TARGETS = {
        java_block: { name: 'Java Block/Item (.json)', extension: '.json' },
        bedrock: { name: 'Bedrock Model (.geo.json)', extension: '.geo.json' }
    };



    // ----- Plugin -----

    let exportAction;

    BBPlugin.register(PLUGIN_ID, {
        title: 'Bulk Model Export',
        author: 'lukyn76',
        description: 'Convert and export many .bbmodel files at once to Java or Bedrock models.',
        about: 'Adds File > Bulk Export Models... Pick a folder of .bbmodel files, choose Java or Bedrock, ' +
            'and get the models and textures written out in a resource pack layout. ' +
            'Java models are fitted into the -16..32 limit as a whole, so nothing gets cut off.',
        icon: 'icon.svg',
        version: '1.0.0',
        min_version: '5.0.0',
        variant: 'desktop',
        tags: ['Minecraft: Java Edition', 'Exporter'],

        onload() {
            exportAction = new Action('bulk_export_models', {
                name: 'Bulk Export Models...',
                description: 'Convert and export several .bbmodel files at once',
                icon: 'drive_folder_upload',
                click: openExportDialog
            });
            MenuBar.addAction(exportAction, 'file');
        },

        onunload() {
            exportAction?.delete();
        }
    });


    // ----- Dialog -----

    function openExportDialog() {
        const last = loadSettings();

        const targetOptions = {};
        for (const [id, target] of Object.entries(TARGETS)) targetOptions[id] = target.name;

        new Dialog({
            id: 'bulk_export_dialog',
            title: 'Bulk Export Models',
            width: 640,
            form: {
                input_dir: { type: 'folder', label: 'Input folder (.bbmodel files)', value: last.input_dir || '' },
                target: {
                    type: 'select', label: 'Export as', value: last.target || 'java_block',
                    options: targetOptions
                },
                output_dir: {
                    type: 'folder', label: 'Output folder', value: last.output_dir || '',
                    description: 'models/ and textures/ are created inside this folder'
                },
                namespace: {
                    type: 'text', label: 'Namespace', value: last.namespace || '', placeholder: 'my_pack',
                    condition: form => form.target === 'java_block'
                },
                model_folder: { type: 'text', label: 'Model subfolder (optional)', value: last.model_folder || '' },
                texture_folder: { type: 'text', label: 'Texture subfolder (optional)', value: last.texture_folder || '' },
                fit: {
                    type: 'select', label: 'Java size limit', value: last.fit || 'move',
                    condition: form => form.target === 'java_block',
                    options: {
                        warn: 'Only warn',
                        move: 'Move the model into the limit',
                        scale: 'Move, and scale down models bigger than 48'
                    },
                    description: 'Display settings are adjusted so items still look the same in game'
                },
                _: '_',
                lowercase: { type: 'checkbox', label: 'Lowercase file names', value: last.lowercase ?? true },
                overwrite: { type: 'checkbox', label: 'Overwrite existing files', value: last.overwrite ?? false },
                save_bbmodel: { type: 'checkbox', label: 'Also save converted .bbmodel copies', value: last.save_bbmodel ?? false },
                write_report: { type: 'checkbox', label: 'Write bulk_export_report.txt', value: last.write_report ?? true }
            },

            onConfirm(form) {
                const options = {
                    ...form,
                    namespace: (form.namespace || '').trim(),
                    model_folder: cleanFolder(form.model_folder),
                    texture_folder: cleanFolder(form.texture_folder)
                };

                const error = validateOptions(options);
                if (error) {
                    Blockbench.showQuickMessage(error, 3000);
                    return false;
                }
                saveSettings(options);
                startExport(options);
            }
        }).show();
    }

    function validateOptions(options) {
        if (!options.input_dir) return 'Pick an input folder';
        if (!options.output_dir) return 'Pick an output folder';
        if (options.target === 'java_block' && !/^[a-z0-9_.-]+$/.test(options.namespace)) {
            return 'Namespace can only use a-z, 0-9, _ . -';
        }
        return null;
    }

    function startExport(options) {
        runExport(options).catch(error => {
            console.error(error);
            Blockbench.showMessageBox({ title: 'Bulk export failed', message: escapeHtml(error.message || error), icon: 'error' });
        });
    }


    // ----- Export -----

    async function runExport(options) {
        const fs = requireNativeModule('fs', {
            message: 'Bulk Model Export needs to read your .bbmodel files and write the exported models and textures.'
        });
        const path = requireNativeModule('path');
        if (!fs) throw new Error('File access was not granted.');

        const files = findModelFiles(fs, path, options.input_dir);
        if (!files.length) {
            Blockbench.showMessageBox({ title: 'Bulk export', message: 'No .bbmodel files found.' });
            return;
        }

        const report = createReport();
        const usedIds = new Set();
        const previousProject = Project;

        for (let i = 0; i < files.length; i++) {
            Blockbench.setProgress(i / files.length);
            await exportFile(files[i], options, { fs, path, report, usedIds });
        }

        Blockbench.setProgress(0);
        if (ModelProject.all.includes(previousProject)) previousProject.select();

        if (options.write_report) writeReportFile(fs, path, options, report);
        showReport(report);
    }

    function findModelFiles(fs, path, folder) {
        return fs.readdirSync(folder)
            .filter(name => name.toLowerCase().endsWith('.bbmodel'))
            .sort()
            .map(name => path.join(folder, name));
    }

    async function exportFile(filePath, options, { fs, path, report, usedIds }) {
        const fileName = path.basename(filePath);
        const id = toFileId(fileName.replace(/\.bbmodel$/i, ''), options.lowercase);
        const target = TARGETS[options.target];
        const isJava = options.target === 'java_block';
        const warn = message => report.warnings.push(`${id}: ${message}`);

        if (usedIds.has(id)) {
            report.skipped.push(`${fileName}: "${id}" is already used by another file`);
            return;
        }
        usedIds.add(id);

        let data;
        try {
            data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (error) {
            report.errors.push(`${fileName}: could not read the file (${error.message})`);
            return;
        }

        const sourceFormat = data.meta?.model_format;
        if (!Formats[sourceFormat]) {
            report.skipped.push(`${fileName}: unknown format "${sourceFormat}"`);
            return;
        }

        const modelPath = joinPath(options.model_folder, id) + target.extension;
        const modelFile = path.join(options.output_dir, 'models', modelPath);
        if (fs.existsSync(modelFile) && !options.overwrite) {
            report.skipped.push(`${fileName}: models/${modelPath} already exists`);
            return;
        }

        setupProject(Formats[sourceFormat]);
        const project = Project;
        const notes = [];

        try {
            Codecs.project.parse(data, filePath);
            await waitForTextures();

            if (sourceFormat !== options.target) {
                convertProject(options.target, warn);
                notes.push(`converted from ${sourceFormat}`);
            }

            let fit = NO_FIT;
            if (isJava) {
                fit = planFit(getModelBounds(), options.fit);
                if (!isNoFit(fit)) {
                    applyFit(fit);
                    notes.push(describeFit(fit));
                }
            }

            const textures = assignTexturePaths(id, options);
            const model = compileModel(id, options, fit, warn);
            const savedTextures = writeTextures(textures, model, options, { fs, path, warn });

            fs.mkdirSync(path.dirname(modelFile), { recursive: true });
            fs.writeFileSync(modelFile, autoStringify(model));

            if (options.save_bbmodel) {
                const bbmodelFile = path.join(options.output_dir, 'bbmodel', id + '.bbmodel');
                fs.mkdirSync(path.dirname(bbmodelFile), { recursive: true });
                fs.writeFileSync(bbmodelFile, Codecs.project.compile());
            }

            if (isJava) checkJavaModel(model, warn);

            let line = `${id} -> models/${modelPath} [${savedTextures.join(', ') || 'no textures'}]`;
            if (notes.length) line += ` (${notes.join(', ')})`;
            report.exported.push(line);

        } catch (error) {
            console.error(error);
            report.errors.push(`${fileName}: ${error.message || error}`);
        } finally {
            await project.close(true);
        }
    }

    // Textures load async, wait for them
    async function waitForTextures(timeout = 4000) {
        const start = Date.now();
        const isLoaded = texture => texture.loaded || texture.error || texture.img?.naturalWidth;

        while (!Texture.all.every(isLoaded) && Date.now() - start < timeout) {
            await new Promise(resolve => setTimeout(resolve, 30));
        }
    }

    function convertProject(targetFormat, warn) {
        const rotationsBefore = new Map(Cube.all.map(cube => [cube.uuid, cube.rotation.slice()]));
        const meshCount = Mesh.all.length;

        // Blockbench clamps each cube on its own when converting, which cuts models.
        // Turn it off, we fit the whole model later.
        const sizeLimit = settings.deactivate_size_limit;
        const sizeLimitWasOff = sizeLimit.value;
        sizeLimit.value = true;
        try {
            Formats[targetFormat].convertTo();
        } finally {
            sizeLimit.value = sizeLimitWasOff;
        }

        const changedRotations = Cube.all.filter(cube => {
            const before = rotationsBefore.get(cube.uuid);
            return before && before.some((angle, axis) => Math.abs(angle - cube.rotation[axis]) > 1e-6);
        }).length;

        if (changedRotations) warn(`${changedRotations} cube rotation(s) changed during conversion, check them`);
        if (meshCount && targetFormat === 'java_block') warn(`${meshCount} mesh(es) removed, Java models only support cubes`);
        if (targetFormat !== 'java_block' && Texture.all.length > 1 && Formats[targetFormat].single_texture) {
            warn('model uses several textures but the target format supports only one');
        }
    }

    // Rename textures to <namespace>:<folder>/<id> (or <id>/<texture> if there are more)
    function assignTexturePaths(id, options) {
        const hasSeveral = Texture.all.length > 1;
        const usedNames = new Set();
        const texturePaths = new Map();

        for (const texture of Texture.all) {
            let texturePath = joinPath(options.texture_folder, id);

            if (hasSeveral) {
                const baseName = toFileId(texture.name.replace(/\.\w+$/, ''), options.lowercase) || 'texture';
                let name = baseName;
                for (let n = 2; usedNames.has(name); n++) name = `${baseName}_${n}`;
                usedNames.add(name);
                texturePath = joinPath(texturePath, name);
            }

            const lastSlash = texturePath.lastIndexOf('/');
            texture.namespace = options.target === 'java_block' ? options.namespace : '';
            texture.folder = texturePath.substring(0, Math.max(lastSlash, 0));
            texture.name = texturePath.substring(lastSlash + 1) + '.png';
            texturePaths.set(texture, texturePath);
        }
        return texturePaths;
    }

    function compileModel(id, options, fit, warn) {
        if (options.target === 'bedrock') {
            Project.geometry_name = id;
            return Codecs.bedrock.compile({ raw: true });
        }

        const model = Codecs.java_block.compile({ raw: true, prevent_dialog: true });
        if (!isNoFit(fit)) {
            adjustDisplayForFit(model, fit).forEach(warn);
        }
        return model;
    }

    function writeTextures(texturePaths, model, options, { fs, path, warn }) {
        // Only save textures the model uses
        const usedLinks = new Set();
        for (const value of Object.values(model.textures || {})) {
            usedLinks.add(typeof value === 'string' ? value : value.sprite);
        }
        const isUsed = texture => options.target !== 'java_block' || usedLinks.has(texture.javaTextureLink());

        const saved = [];
        for (const [texture, texturePath] of texturePaths) {
            if (!isUsed(texture)) continue;

            const file = path.join(options.output_dir, 'textures', texturePath + '.png');
            if (fs.existsSync(file) && !options.overwrite) {
                warn(`textures/${texturePath}.png already exists, kept the old one`);
                continue;
            }

            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, dataUrlToBytes(texture.getDataURL()));

            const animated = texture.frameCount > 1;
            if (animated) {
                fs.writeFileSync(file + '.mcmeta', JSON.stringify(texture.getMCMetaContent(), null, '\t'));
            } else if (fs.existsSync(file + '.mcmeta') && options.overwrite) {
                fs.unlinkSync(file + '.mcmeta');
            }

            saved.push(texturePath + '.png' + (animated ? ` (${texture.frameCount} frames)` : ''));
        }
        return saved;
    }

    function checkJavaModel(model, warn) {
        const elements = model.elements || [];
        if (!elements.length) warn('model has no elements');
        if (!model.display) warn('model has no display settings');

        const outside = elements.filter(element => {
            for (let axis = 0; axis < 3; axis++) {
                const low = Math.min(element.from[axis], element.to[axis]);
                const high = Math.max(element.from[axis], element.to[axis]);
                if (low < JAVA_MIN - 1e-6 || high > JAVA_MAX + 1e-6) return true;
            }
            return false;
        });
        if (!outside.length) return;

        const bounds = getBounds(elements.map(element => [element.from, element.to]));
        const tooBig = bounds.size.some(size => size > JAVA_SIZE);
        const hint = tooBig ? 'it is bigger than 48, use "scale down" or resize it' : 'use "move" or move it';
        warn(`${outside.length} element(s) outside ${JAVA_MIN}..${JAVA_MAX} (${describeBounds(bounds)}), ${hint}`);
    }


    // ----- Fit -----
    // Moves/scales the whole model: newPoint = point * scale + offset

    const NO_FIT = { scale: 1, offset: [0, 0, 0], tooBig: false };

    function isNoFit(fit) {
        return fit.scale === 1 && fit.offset.every(value => value === 0);
    }

    function getModelBounds() {
        const boxes = Cube.all
            .filter(cube => cube.export !== false)
            .map(cube => {
                const inflate = cube.inflate || 0;
                return [
                    cube.from.map((value, axis) => Math.min(value, cube.to[axis]) - inflate),
                    cube.to.map((value, axis) => Math.max(value, cube.from[axis]) + inflate)
                ];
            });
        return getBounds(boxes);
    }

    function getBounds(boxes) {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];

        for (const [from, to] of boxes) {
            for (let axis = 0; axis < 3; axis++) {
                min[axis] = Math.min(min[axis], from[axis], to[axis]);
                max[axis] = Math.max(max[axis], from[axis], to[axis]);
            }
        }

        const empty = boxes.length === 0;
        const size = empty ? [0, 0, 0] : max.map((value, axis) => value - min[axis]);
        return { min, max, size, empty };
    }

    function planFit(bounds, mode) {
        const fit = { scale: 1, offset: [0, 0, 0], tooBig: false };
        if (bounds.empty || mode === 'warn') return fit;

        const largestSide = Math.max(...bounds.size);
        if (largestSide > JAVA_SIZE) {
            if (mode === 'scale') {
                fit.scale = Math.floor(JAVA_SIZE / largestSide * 10000) / 10000;
            } else {
                fit.tooBig = true;
            }
        }

        // Move just enough to fit
        for (let axis = 0; axis < 3; axis++) {
            const low = bounds.min[axis] * fit.scale;
            const high = bounds.max[axis] * fit.scale;

            if (high - low > JAVA_SIZE) continue;
            if (low < JAVA_MIN) fit.offset[axis] = JAVA_MIN - low;
            else if (high > JAVA_MAX) fit.offset[axis] = JAVA_MAX - high;
        }
        return fit;
    }

    function applyFit(fit) {
        const transform = point => point.map((value, axis) => value * fit.scale + fit.offset[axis]);

        for (const cube of Cube.all) {
            cube.from = transform(cube.from);
            cube.to = transform(cube.to);
            cube.origin = transform(cube.origin);
            if (cube.inflate) cube.inflate *= fit.scale;
        }
    }

    function describeFit(fit) {
        const parts = [];
        if (fit.scale !== 1) parts.push(`scaled to ${fit.scale}`);
        if (fit.offset.some(value => value !== 0)) parts.push(`moved by [${fit.offset.map(value => round(value, 3)).join(', ')}]`);
        return parts.join(' and ') + ', display adjusted';
    }

    // Fix display settings after moving/scaling so the item looks the same in game.
    // Minecraft draws it as: translation + rotation * (scale * (point - 8))
    function adjustDisplayForFit(model, fit) {
        const warnings = [];
        const oldDisplay = model.display || {};
        const newDisplay = {};

        // How far the center (8, 8, 8) moved
        const centerShift = fit.offset.map(offset => 8 * fit.scale + offset - 8);

        const extraSlots = Object.keys(oldDisplay).filter(slot => !DISPLAY_SLOTS.includes(slot));

        for (const slot of [...DISPLAY_SLOTS, ...extraSlots]) {
            const fallbackSlot = LEFT_HAND_FALLBACK[slot];
            const current = oldDisplay[slot] || oldDisplay[fallbackSlot] || {};

            const rotation = current.rotation || [0, 0, 0];
            const translation = current.translation || [0, 0, 0];
            const scale = (current.scale || [1, 1, 1]).map(value => value / fit.scale);

            const shift = scale.map((value, axis) => value * centerShift[axis]);
            if (fallbackSlot) shift[0] = -shift[0]; // left hand is mirrored on X

            const rotatedShift = rotateVector(shift, rotation);
            const newTranslation = translation.map((value, axis) => value - rotatedShift[axis]);

            const entry = {};
            if (rotation.some(value => value !== 0)) entry.rotation = rotation.slice();
            if (newTranslation.some(value => round(value) !== 0)) entry.translation = newTranslation.map(value => round(value));
            if (scale.some(value => round(value) !== 1)) entry.scale = scale.map(value => round(value));
            if (Object.keys(entry).length) newDisplay[slot] = entry;

            if (newTranslation.some(value => Math.abs(value) > MAX_DISPLAY_TRANSLATION)) {
                warnings.push(`display "${slot}" translation is over ${MAX_DISPLAY_TRANSLATION}, Minecraft will cap it`);
            }
            if (scale.some(value => Math.abs(value) > MAX_DISPLAY_SCALE)) {
                warnings.push(`display "${slot}" scale is over ${MAX_DISPLAY_SCALE}, Minecraft will cap it`);
            }
        }

        if (Object.keys(newDisplay).length) model.display = newDisplay;
        else delete model.display;

        return warnings;
    }

    // Same rotation order as Minecraft (X * Y * Z)
    function rotateVector(vector, degrees) {
        const [rx, ry, rz] = degrees.map(angle => angle * Math.PI / 180);
        let [x, y, z] = vector;

        [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
        [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
        [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];

        return [x, y, z];
    }


    // ----- Report -----

    function createReport() {
        return { exported: [], warnings: [], skipped: [], errors: [] };
    }

    function reportSections(report) {
        return [
            ['Exported', report.exported],
            ['Warnings', report.warnings],
            ['Skipped', report.skipped],
            ['Errors', report.errors]
        ];
    }

    function writeReportFile(fs, path, options, report) {
        const lines = [
            `Bulk Model Export - ${new Date().toLocaleString()}`,
            `Export as: ${TARGETS[options.target].name}`,
            `Output: ${options.output_dir}`
        ];
        if (options.target === 'java_block') lines.push(`Namespace: ${options.namespace}, size limit: ${options.fit}`);

        for (const [title, entries] of reportSections(report)) {
            lines.push('', `== ${title} (${entries.length})`, ...entries);
        }

        fs.writeFileSync(path.join(options.output_dir, 'bulk_export_report.txt'), lines.join('\n'));
    }

    function showReport(report) {
        let html = '';
        for (const [title, entries] of reportSections(report)) {
            if (!entries.length) continue;
            const items = entries.map(entry => `<li>${escapeHtml(entry)}</li>`).join('');
            html += `<h3>${title} (${entries.length})</h3><ul style="margin: 0 0 8px 18px">${items}</ul>`;
        }

        const failed = report.skipped.length + report.errors.length;
        new Dialog({
            id: 'bulk_export_report',
            title: `Exported ${report.exported.length}, ${report.warnings.length} warnings, ${failed} skipped`,
            width: 780,
            singleButton: true,
            lines: [`<div style="max-height: 60vh; overflow: auto; user-select: text">${html || 'Nothing to export.'}</div>`]
        }).show();
    }


    // ----- Utils -----

    function loadSettings() {
        try {
            return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
        } catch {
            return {};
        }
    }

    function saveSettings(values) {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(values));
    }

    // "Blade of Fortune" -> "blade_of_fortune"
    function toFileId(name, lowercase) {
        let id = name.trim().replace(/\s+/g, '_');
        if (lowercase) id = id.toLowerCase();
        return id.replace(/[^a-zA-Z0-9_.-]/g, '');
    }

    function cleanFolder(folder) {
        return (folder || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    }

    function joinPath(...parts) {
        return parts.filter(Boolean).join('/');
    }

    function describeBounds(bounds) {
        return ['x', 'y', 'z']
            .map((axis, i) => `${axis} ${round(bounds.min[i], 2)}..${round(bounds.max[i], 2)}`)
            .join(', ');
    }

    function round(value, decimals = 5) {
        const factor = 10 ** decimals;
        return Math.round(value * factor) / factor + 0; // avoid -0
    }

    function dataUrlToBytes(dataUrl) {
        const binary = atob(dataUrl.split(',')[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

})();
