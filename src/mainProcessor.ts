import { MainFolder, SourceFileInfo, FilesToProcess, Asset } from "./types";
import processMarkdown from "./markdownProcessor";
import { Notice } from 'obsidian';
import { logger } from 'main';
// When you use export default in a module, that module becomes an object and what you're exporting becomes a property of that object.
// import { logger } from 'main';
// instead of 
// import logger from 'main';
import * as fs from 'fs';
import * as path from 'path';
import { config } from "main";
import util from 'util';



export default async function obsidiosaurusProcess(basePath: string): Promise<boolean> {
    const websitePath = path.join(basePath, "website")
    const vaultPath = path.join(basePath, "vault")
    // Get the main folders of the vault e.g. docs, assets, ..
    const mainFolders = getMainfolders(vaultPath);
    mainFolders.forEach(folder => processSingleFolder(folder, vaultPath));

    if (config.debug) {
        logger.info('📁 Folder structure with Files: %s', JSON.stringify(mainFolders));
    }

    // Get all the file including the necessary infos from the mainfolders
    const allInfo = mainFolders.flatMap(folder => folder.files.map(file => getSourceFileInfo(basePath, folder, file, vaultPath)));

    // Separate assets from the other files
    const allSourceFilesInfo: Partial<SourceFileInfo>[] = allInfo.filter(info => info.type !== 'assets');
    const allSourceAssetsInfo: Partial<SourceFileInfo>[]  = allInfo.filter(info => info.type === 'assets');

    // Try to read in the targetJson, this should represent the current status of the files in Docusaurus
    // when there is no file initialize an empty array
    let targetJson: SourceFileInfo[];

    try {
        const jsonData = await fs.promises.readFile(path.join(basePath,'allFilesInfo.json'), 'utf-8');
        targetJson = JSON.parse(jsonData);
    } catch (error) {
        console.error('Error reading file: XXXX', error);
        targetJson = []; // Provide an empty JSON array as the default value
    }

    // Verify if every file exists from target.json
    // When not remove it from targetJson
    targetJson = await checkFilesExistence(targetJson)

    // Check if dateModified of Source is newer or the file doesnt exist anymore in Vault
    // Get an array with indexes to delete from back
    const filesToDelete = await getFilesToDelete(allSourceFilesInfo, targetJson);

    // Delete the files with the index array from Docusaurus
    await deleteFiles(filesToDelete, targetJson, basePath);
    let assetJson = [];

    // Read in the assetInfo Json File, this contains all infos about currently used images, pdfs,..
    try {
        assetJson = JSON.parse(await fs.promises.readFile(path.join(basePath,'assetInfo.json'), 'utf-8'));
      } catch (error) {
        if (error.code === 'ENOENT') {
          // If file doesn't exist, create it with an empty JSON array
          await fs.promises.writeFile(path.join(basePath,'assetInfo.json'), '[]');
          console.log('Created assetInfo.json');
        } else {
          console.error('Error reading file:', error);
        }
      }
      
    //await processAssetDeletion(filesToDelete, assetJson, allSourceAssetsInfo, websitePath)
    await removeAssetReferences(filesToDelete, assetJson, websitePath);
    await fs.promises.writeFile(path.join(basePath,'assetJson_.json'), JSON.stringify(assetJson, null, 2));

    // Write files

    await fs.promises.writeFile(path.join(basePath,'allFilesInfo.json'), JSON.stringify(targetJson, null, 2));
    targetJson = JSON.parse(await fs.promises.readFile(path.join(basePath,'allFilesInfo.json'), 'utf-8'));

    await fs.promises.writeFile(path.join(basePath,'allSourceAssetsInfo.json'), JSON.stringify(allSourceAssetsInfo, null, 2));


    const filesToProcess = await compareSource(allSourceFilesInfo, targetJson);

    if (filesToProcess.length == 0) {
        new Notice(`💤 Nothing to process`)
        return true;
    }

    new Notice(`⚙ Processing ${filesToProcess.length} Files`)

    // Get the indices of files to process
    const filesToProcessIndices = filesToProcess.map(file => file.index);

    // Filter allSourceFilesInfo to only include files to process
    const filesToMarkdownProcess = allSourceFilesInfo.filter((_, index) => filesToProcessIndices.includes(index));

    await copyMarkdownFilesToTarget(filesToMarkdownProcess, basePath, targetJson, assetJson);

    await fs.promises.writeFile(path.join(basePath,'allFilesInfo.json'), JSON.stringify(targetJson, null, 2));

    const assetsToProcess = await getAssetsToProcess(assetJson);

    new Notice(`⚙ Processing ${assetsToProcess.length} Assets`)

    await copyAssetFilesToTarget(vaultPath, websitePath, assetJson, assetsToProcess)


    logger.info("✅ Obsidiosaurus run successfully");
    new Notice("✅ Obsidiosaurus run successfully")

    return true;
}

////////////////////////////////////////////////////////////////
// FOLDERS
////////////////////////////////////////////////////////////////

function getMainfolders(folderPath: string): MainFolder[] {
    const folders: MainFolder[] = [];
    const absoluteFolderPath = path.resolve(folderPath);

    logger.info('📁 Processing path: %s', absoluteFolderPath);

    const objects = fs.readdirSync(absoluteFolderPath);
    if (config.debug) {
        logger.info('📂 Found files: %o', objects);
    }
    objects.forEach(object => {
        const filePath = path.join(absoluteFolderPath, object);
        const stats = fs.statSync(filePath);

        if (stats.isDirectory()) {
            let type: string | undefined;
            if (object.endsWith("__blog")) {
                type = "blogMulti";
            } else if (object.includes("blog")) {
                type = "blog";
            } else if (object.includes("docs")) {
                type = "docs";
            } else if (object.includes(config.obsidianAssetSubfolderName)) {
                type = "assets";
            } else {
                type = "ignore";
            }

            if (type !== "ignore" && type !== undefined) {
                const folderObject: MainFolder = {
                    name: object,
                    type: type,
                    files: []
                };
                folders.push(folderObject);
            }

            if (config.debug) {
                logger.info('🔍 File: %s, Type: %s', object, type);
            }
        }
    });

    logger.info('📤 Returning folders: %o', folders);
    return folders;
}

function searchFilesInFolder(directory: string): string[] {
    let results: string[] = [];
    let skipFiles = ".DS_Store"
    const files = fs.readdirSync(directory);

    files.forEach(file => {

        if (skipFiles.includes(file)) {
            console.log(`⏭️ Skipped ${file}`)
            return;
        }

        const filePath = path.join(directory, file);
        const stat = fs.statSync(filePath);

        if (stat && stat.isDirectory()) {
            results = results.concat(searchFilesInFolder(filePath));
        } else {
            results.push(filePath);
        }
    });

    return results;
}

function processSingleFolder(folder: MainFolder, basePath: string): void {
    const dirPath = path.join(basePath, folder.name);
    const files = searchFilesInFolder(dirPath);
    folder.files = files;

    if (config.debug) {
        logger.info('📄 Vault Files for %s: %s', folder.name, JSON.stringify(files));
    }
}

async function deleteParentDirectories(filepath: string) {
    let dirPath = path.dirname(filepath);
    while (dirPath !== path.dirname(dirPath)) { // while dirPath has a parent directory
        try {
            await fs.promises.rmdir(dirPath);
            logger.info(`🧨 Successfully deleted directory ${dirPath}`);
        } catch (error) {
            // Ignore the error if the directory is not empty
            if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST' && error.code !== 'EPERM') {
                logger.info(`❌ Failed to delete directory ${dirPath}: ${error}`);
            }
            return;
        }
        dirPath = path.dirname(dirPath);
    }
}

async function ensureDirectoryExistence(filePath: string) {
    const dir = path.dirname(filePath);

    if (fs.existsSync(dir)) {
        return true;
    }

    await fs.promises.mkdir(dir, { recursive: true });
}

async function compareSource(sourceJson: Partial<SourceFileInfo>[], targetJson: Partial<SourceFileInfo>[]): Promise<FilesToProcess[]> {
    const filesToProcess: FilesToProcess[] = [];

    await fs.promises.writeFile('source.json', JSON.stringify(sourceJson, null, 2));
    await fs.promises.writeFile('target.json', JSON.stringify(targetJson, null, 2));

    // Iterate over sourceJson files
    sourceJson.forEach((sourceFile, i) => {
        // Find a matching file in targetJson
        const matchingTargetFile = targetJson.find(file => file.pathSourceRelative === sourceFile.pathSourceRelative);

        // Add to the filesToProcess array if no matching file is found
        if (!matchingTargetFile) {
            filesToProcess.push({ index: i, reason: "Does not exist in targetJson" });
            if (config.debug) {
                logger.info('📝 File to process: %s', sourceFile.pathSourceRelative);
            }

        }
    });

    return filesToProcess;
}

////////////////////////////////////////////////////////////////
// FILES
////////////////////////////////////////////////////////////////

function getSourceFileInfo(basePath: string, folder: MainFolder, filePath: string, vaultPath): Partial<File> {
    filePath = path.resolve(filePath);
    const stats = fs.statSync(filePath);
    const fileName = path.basename(filePath);

    const { fileNameClean, fileExtension, language } = sanitizeFileName(fileName);

    const pathSourceRelative = path.relative(vaultPath, filePath); // basePath is defined in outer scope.

    let sourceFileInfo: Partial<SourceFileInfo> = {
        fileName,
        fileNameClean,
        fileExtension,
        language,
        mainFolder: folder.name,
        parentFolder: path.basename(path.dirname(filePath)),
        pathSourceAbsolute: filePath,
        pathSourceRelative,
        dateModified: stats.mtime,
        size: stats.size,
        type: folder.type // Assuming type is defined in the MainFolder interface.
    };

    sourceFileInfo = getTargetPath(sourceFileInfo, basePath)

    return sourceFileInfo;
}

function sanitizeFileName(fileName: string): { fileNameClean: string, fileExtension: string, language: string } {
    const parsedPath = path.parse(fileName);
    const fileNameWithoutExtension = parsedPath.name;
    const fileExtension = parsedPath.ext;

    let fileNameClean = fileNameWithoutExtension;

    const languageMatch = fileNameClean.match(/__([a-z]{2})$/i);
    let language = null;
    if (languageMatch) {
        fileNameClean = fileNameClean.split('__')[0];
        language = languageMatch ? languageMatch[1] : null;
    }

    if (language === null) {
        if (config && config.mainLanguage) {
            language = config.mainLanguage;
        } else {
            const errorMessage = '❌ Main language not defined in the configuration';
            logger.error(errorMessage);
            throw new Error(errorMessage);
        }
    }

    return { fileNameClean: fileNameClean.trim(), fileExtension, language };
}

function getTargetPath(sourceFileInfo: Partial<SourceFileInfo>, basePath: string): Partial<SourceFileInfo> {
    console.log(sourceFileInfo)
    const { type, language, pathSourceRelative, mainFolder, parentFolder, fileExtension } = sourceFileInfo;

    if (!type || !language || !pathSourceRelative || !parentFolder || !fileExtension || !mainFolder) {
        logger.error('🚨 Required properties missing on sourceFileInfo');
        throw new Error('Missing required properties on sourceFileInfo');
    }

    // Check if main language is used
    const isMainLanguage = language === config.mainLanguage;

    // Construct main path depending on the file type
    const mainPathDict = {
        'docs': isMainLanguage ? "" : `i18n\\${language}\\docusaurus-plugin-content-docs\\current`,
        'blog': isMainLanguage ? "" : `i18n\\${language}\\docusaurus-plugin-content-blog\\current`,
        'blogMulti': isMainLanguage || !mainFolder ? "" : `i18n\\${language}\\docusaurus-plugin-content-blog-${mainFolder}`,
        'assets': `static\\${config.docusaurusAssetSubfolderName}`,
    };

    //@ts-ignore
    const mainPath = mainPathDict[type] || "";

    if (config.debug) {
        logger.info('🔍 File: %s, Type: %s, Main Path: %s', pathSourceRelative, type, mainPath);
    }

    let finalPathSourceRelative = pathSourceRelative;

    if (parentFolder.endsWith('+')) {

        const pathParts = finalPathSourceRelative.split("\\");

        pathParts.pop();
        console.log(pathParts)

        if (pathParts.length > 0) {

            let lastPart = pathParts[pathParts.length - 1];
            console.log(lastPart)

            // Remove '+' from the end of the parent folder
            if (lastPart.endsWith('+')) {
                lastPart = lastPart.slice(0, -1);
                console.log(lastPart)
                pathParts[pathParts.length - 1] = lastPart;  // update the lastpart in the path array
            }

            finalPathSourceRelative = pathParts.join("\\") + fileExtension;

            if (config.debug) {
                logger.info('🔧 Removed Parent Folder: New Path: %s', finalPathSourceRelative);
            }
        }
    }

    // Remove language from path
    finalPathSourceRelative = finalPathSourceRelative.replace(`__${language}`, "");

    // Remove .md ending from .yml file
    if (finalPathSourceRelative.endsWith(".yml.md")) {
        finalPathSourceRelative = finalPathSourceRelative.replace(".yml.md", ".yml");
        if (config.debug) {
            logger.info('🔧 Removed .md from .yml file: New Path: %s', finalPathSourceRelative);
        }
    }

    sourceFileInfo.pathTargetRelative = path.join(mainPath, finalPathSourceRelative);
    sourceFileInfo.pathTargetAbsolute = path.join(basePath, config.docusaurusWebsiteDirectory, sourceFileInfo.pathTargetRelative)

    return sourceFileInfo;
}

/**
 * This asynchronous function compares source and target files to identify files that need to be deleted.
 *
 * @param {Partial<SourceFileInfo>[]} allSourceFilesInfo - Array of source files information. Each object containing details about a source file
 * @param {SourceFileInfo[]} targetJson - Array of target files information. Each element is an object containing details about a file from the target.
 * @return {Promise<FilesToProcess[]>} - A promise that resolves with an array of objects containing indices of files to delete and the reasons for their deletion. Each object has two properties: 'index' and 'reason'.
 *
 * @async
 *
 * This function iterates over each file in the 'targetJson' array and attempts to find a matching file in the 'allSourceFilesInfo' array based on their relative paths. If no matching source file is found, it implies that the target file should be deleted, and it is added to the 'filesToDelete' array with the reason "it does not exist in sourceJson".
 * 
 * If a matching source file is found, their modification dates are compared. If the source file has a more recent modification date than the target file, it implies that the target file should be updated. As a part of the update process, the older target file needs to be deleted first, so it is added to the 'filesToDelete' array with the reason "its last modification date is older than the date in sourceJson".
 * The function returns a promise that resolves with the 'filesToDelete' array.
 */
async function getFilesToDelete(allSourceFilesInfo: Partial<SourceFileInfo>[], targetJson: SourceFileInfo[]): Promise<FilesToProcess[]> {
    // Load JSON data

    const sourceJson: Partial<SourceFileInfo>[] = allSourceFilesInfo;

    const filesToDelete: FilesToProcess[] = [];

    // Iterate over targetJson files
    targetJson.forEach((targetFile, i) => {
        // Find a matching file in sourceJson
        const matchingSourceFile = sourceJson.find(file => file.pathSourceRelative === targetFile.pathSourceRelative);

        // Create Date objects from dateModified strings
        const targetDate = new Date(targetFile.dateModified);
        const sourceDate = matchingSourceFile?.dateModified ? new Date(matchingSourceFile.dateModified) : null;

        // Add to the filesToDelete array based on certain conditions
        if (!matchingSourceFile) {
            filesToDelete.push({ index: i, reason: "it does not exist in sourceJson", pathKey: targetFile.pathSourceRelative });
            if (config.debug) {
                logger.info('🗑️ File to delete: %s', targetFile.pathSourceRelative);
            }
        } else if (sourceDate && targetDate.getTime() < sourceDate.getTime()) {
            filesToDelete.push({ index: i, reason: `its last modification date ${targetDate} is older than the date in sourceJson ${sourceDate}`, pathKey: targetFile.pathSourceRelative });
            if (config.debug) {
                logger.info('🔄 File to update: %s, Target: %s Source: %s', targetFile.pathSourceRelative, targetDate, sourceDate);
            }
        }
    });

    return filesToDelete;
}

async function deleteFiles(filesToDelete: FilesToProcess[], targetJson: SourceFileInfo[], basePath: string) {
    const errors: Error[] = [];

    // Sort filesToDelete in descending order based on index
    filesToDelete.sort((a, b) => b.index - a.index);

    // Delete files
    for (const fileToDelete of filesToDelete) {
        const targetFile = targetJson[fileToDelete.index];

        try {
            await fs.promises.unlink(path.join(basePath, targetFile.pathTargetRelative));
            logger.info(`✅ Successfully deleted file %s`, targetFile.pathTargetRelative);
            await deleteParentDirectories(path.join(basePath, targetFile.pathTargetRelative));

            // Remove the deleted file from targetJson immediately after successful deletion
            targetJson.splice(fileToDelete.index, 1);
        } catch (error) {
            // If error code is ENOENT, the file was not found, which we consider as a successful deletion.
            if (error.code !== "ENOENT") {
                logger.error(`❌ Failed to delete file %s: %s`, targetFile.pathTargetRelative, error);
                errors.push(error);
                continue; // If deletion failed for other reasons, we keep the file in targetJson.
            }
            logger.info(`🗑️ File %s was not found, considered as deleted`, targetFile.pathTargetRelative);
            targetJson.splice(fileToDelete.index, 1);
        }
    }
}

async function checkFilesExistence(targetJson: SourceFileInfo[]): Promise<SourceFileInfo[]> {
    const existentFiles = await Promise.all(
        targetJson.map(async fileInfo => {
            try {
                await fs.promises.access(fileInfo.pathTargetAbsolute);
                const stats = await fs.promises.stat(fileInfo.pathTargetAbsolute);
                fileInfo.dateModifiedTarget = stats.mtime;
                fileInfo.sizeTarget = stats.size;
                return fileInfo;
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    throw err; // re-throw unexpected errors
                }
                // File doesn't exist, return null
                console.log(`File not fond: ${fileInfo.pathSourceRelative}`)
                return null;
            }
        })
    );
    const len = existentFiles.length
    // Filter out null entries (i.e., non-existent files)
    const files = existentFiles.filter(fileInfo => fileInfo !== null)

    if (config.debug) {
        logger.info("Removed %i Files", len - files.length);
    }

    return files as SourceFileInfo[];
}

////////////////////////////////////////////////////////////////
// Markdown Conversion
////////////////////////////////////////////////////////////////

async function copyMarkdownFilesToTarget(files: Partial<SourceFileInfo>[], basePath: string, targetJson: Partial<SourceFileInfo>[], assetJson: Asset[]) {

    const results: SourceFileInfo[] = [];

    const promises = files.map(async (file) => {
        const { pathTargetAbsolute, pathSourceAbsolute, pathSourceRelative } = file
        // Ensure the directory exists

        if (pathTargetAbsolute && pathSourceAbsolute && pathSourceRelative) {
            await ensureDirectoryExistence(pathTargetAbsolute);

            const sourceContent = await fs.promises.readFile(pathSourceAbsolute, 'utf-8');
            // Actual markdown conversion process
            const transformedContent = await processMarkdown(pathSourceRelative, sourceContent, assetJson);
            if (transformedContent) {
                await fs.promises.writeFile(pathTargetAbsolute, String(transformedContent));
            }

            if (config.debug) {
                logger.info(`📤 Converted file from ${pathSourceAbsolute} to ${pathTargetAbsolute}`);
            }
        }

        results.push(file as SourceFileInfo);

    });

    // Wait for all copy operations to finish
    await Promise.all(promises);

    // Add results to targetJson
    targetJson.push(...results);

    await fs.promises.writeFile(path.join(basePath,'assetInfo.json'), JSON.stringify(assetJson, null, 2));
}

////////////////////////////////////////////////////////////////
// Asset
////////////////////////////////////////////////////////////////

async function removeAssetReferences(filesToDelete: FilesToProcess[], assetJson: Asset[], websitePath: string): Promise<Asset[]> {
    for (const fileToDelete of filesToDelete) {
        if (!fileToDelete.pathKey) {
            continue;
        }

        // Iterate backwards through each asset in the json
        for (let assetIndex = assetJson.length - 1; assetIndex >= 0; assetIndex--) {
            const asset = assetJson[assetIndex];

            // Iterate backwards through each size in the asset
            for (let sizeIndex = asset.sizes.length - 1; sizeIndex >= 0; sizeIndex--) {
                const size = asset.sizes[sizeIndex];

                // Find the index of the filePath in inDocuments array
                const docIndex = size.inDocuments.indexOf(fileToDelete.pathKey);

                // If the filePath is found in the inDocuments array
                if (docIndex !== -1) {
                    // Remove the filePath from inDocuments array
                    size.inDocuments.splice(docIndex, 1);
                    logger.info(`🗑 Removed filePath from inDocuments: ${fileToDelete.pathKey}`);

                    // If inDocuments array is empty, remove the size entry
                    if (size.inDocuments.length === 0) {
                        const assetToRemove = size.newName
                        await removeAssetFromTarget(assetToRemove, config.docusaurusAssetSubfolderName, websitePath)

                        asset.sizes.splice(sizeIndex, 1);
                        logger.info(`🔥 Removed size from sizes: ${size.size}`);
                    }

                    
                }
            }

            // If sizes array is empty, remove the asset entry
            if (asset.sizes.length === 0) {
                assetJson.splice(assetIndex, 1);
                logger.info(`💥 Removed asset from assetJson: ${asset.fileName}`);
            }
        }
    }

    return assetJson;
}

async function removeAssetFromTarget(assetToRemove: string[], docusaurusAssetSubfolderName: string, websitePath: string): Promise<void> {
    for (const asset of assetToRemove) {
        const assetPath = path.join(websitePath, docusaurusAssetSubfolderName, asset);      
        try {
            await fs.promises.unlink(assetPath);
            logger.info(`🗑 Removed asset: ${assetPath}`);
        } catch (error) {
            logger.error(`❌ Error removing asset: ${assetPath}`, error);
        }
    }
}

const copyFile = util.promisify(fs.copyFile);
const mkdir = util.promisify(fs.mkdir);

async function copyAssetFilesToTarget(vaultPathPath: string, websitePath: string, assetJson: Asset[], assetsToProcess: {assetIndex: number, sizeIndex: number, path: string}[] ): Promise<void> {
    
    const docusaurusAssetFolderPath = path.join(websitePath, "static", config.docusaurusAssetSubfolderName)
    await mkdir(docusaurusAssetFolderPath, { recursive: true });

    for (const assetToProcess of assetsToProcess) {
        // Use the indexes to find the original asset and size
        const asset = assetJson[assetToProcess.assetIndex];
        const size = asset.sizes[assetToProcess.sizeIndex];

        // Build the original file path
        const originalFilePath = path.join(vaultPathPath, config.obsidianAssetSubfolderName, asset.originalFileName).replace(/%20/g, " ");

        for (const newName of size.newName) {
            const newFilePath = path.join(docusaurusAssetFolderPath, newName);
            

            // Check if it's an image
            if (["jpg", "png", "webp", "jpeg", "bmp", "gif"].includes(asset.fileExtension)) {
                try {

                    await resizeImage(originalFilePath, newFilePath, size.size);
                    console.log(`Image resized and copied from ${originalFilePath} to ${newFilePath}`);
                } catch (error) {
                    console.error(`Failed to resize image and copy from ${originalFilePath} to ${newFilePath}: ${error.message}`);
                }
            } else {
                // Copy the file to the new location
                try {
                    await copyFile(originalFilePath, newFilePath);
                    console.log(`File copied from ${originalFilePath} to ${newFilePath}`);
                } catch (error) {
                    console.error(`Failed to copy file from ${originalFilePath} to ${newFilePath}: ${error.message}`);
                }
            }
        }
    }
}

const gm = require('gm').subClass({ imageMagick: '7+' });

async function resizeImage(originalFilePath: string, newFilePath: string, size: string): Promise<void> {

    let width: number;
    let height: string | number;

    if (size === "standard") {
        width = config.convertedImageMaxWidth;
        height = '';  // auto height
    } else {
        const dimensions = size.split("x");
        width = parseInt(dimensions[0]);
        height = dimensions.length > 1 ? parseInt(dimensions[1]) : '';
    }

    gm(originalFilePath)
    .resize(width, height, '!')
    .noProfile()
    .write(newFilePath, function (err) {
        if (err) console.log(err);
        if (!err) console.log('done');
      });
}

async function getAssetsToProcess(assetJson: Asset[]): Promise<{assetIndex: number, sizeIndex: number, path: string}[]> {
    const documents = [];

    // Loop through all assets
    for (const [assetIndex, asset] of assetJson.entries()) {
        // Loop through all sizes of each asset
        for (const [sizeIndex, size] of asset.sizes.entries()) {
            // Add all documents for each size to the array, along with the asset and size index
            for (const name of size.newName) {
                documents.push({assetIndex, sizeIndex, path: name});
            }
        }
    }

    // Check if each document exists, if it does remove it from the array
    const assetsToProcess = documents.filter(document => {
        
        if (fs.existsSync(document.path)) {
            return false; // Exists, so remove it from the array
        }
        return true; // Doesn't exist, so keep it in the array
    });

    

    return assetsToProcess;
}