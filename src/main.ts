import { App, Plugin, TAbstractFile, TFile, EmbedCache, LinkCache, Notice, MarkdownView, getLinkpath, CachedMetadata } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS, SettingTab } from './settings';
import { LinksHandler, LinkChangeInfo } from './links-handler';
import { path } from './path';
import { Md5 } from './md5/md5';

export default class ConsistentAttachmentsAndLinks extends Plugin {
	settings: PluginSettings;
	lh: LinksHandler;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new SettingTab(this.app, this));

		this.addCommand({
			id: 'rename-all-attachments',
			name: 'Rename all attachments',
			callback: () => this.renameAllAttachments()
		});

		this.addCommand({
			id: 'rename-only-active-attachments',
			name: 'Rename only active attachments',
			callback: () => this.renameOnlyActiveAttachments()
		});

		this.lh = new LinksHandler(this.app, "Unique attachments: ");
	}

	async renameAllAttachments() {
		let files = this.app.vault.getFiles();
		let renamedCount = 0;

		for (let file of files) {
			let renamed = await this.renameAttachmentIfNeeded(file);
			if (renamed)
				renamedCount++;
		}

		if (renamedCount == 0)
			new Notice("No files found that need to be renamed");
		else if (renamedCount == 1)
			new Notice("Renamed 1 file.");
		else
			new Notice("Renamed " + renamedCount + " files.");
	}

	async renameOnlyActiveAttachments() {
		let activeFile = this.app.workspace.getActiveFile();
		
		if (!activeFile) {
			new Notice("No active file");
			return;
		}

		// Only handle markdown and canvas files
		if (!activeFile.path.endsWith(".md") && !activeFile.path.endsWith(".canvas")) {
			new Notice("Active file must be a markdown or canvas file");
			return;
		}
		
		let renamedCount = await this.renameAttachmentsForActiveMD(activeFile);
		
		if (renamedCount == 0)
			new Notice("No files found that need to be renamed");
		else if (renamedCount == 1)
			new Notice("Renamed 1 file.");
		else
			new Notice("Renamed " + renamedCount + " files.");
	}

	async renameAttachmentIfNeeded(file: TAbstractFile): Promise<boolean> {
		let filePath = file.path;
		if (this.checkFilePathIsIgnored(filePath) || !this.checkFileTypeIsAllowed(filePath)) {
			return false;
		}

		let ext = path.extname(filePath);
		let baseName = path.basename(filePath, ext);
		let validBaseName = await this.generateValidBaseName(filePath);
		if (baseName == validBaseName) {
			return false;
		}

		// Get both markdown and canvas notes that reference this file
		let mdNotes = await this.lh.getNotesThatHaveLinkToFile(filePath);
		let canvasNotes = await this.lh.getNotesThatHaveLinkToFileInCanvas(filePath);
		let allNotes = [...new Set([...(mdNotes || []), ...(canvasNotes || [])])];

		if (!allNotes || allNotes.length == 0) {
			if (this.settings.renameOnlyLinkedAttachments) {
				return false;
			}
		}

		let validPath = this.lh.getFilePathWithRenamedBaseName(filePath, validBaseName);
		let targetFileAlreadyExists = await this.app.vault.adapter.exists(validPath);

		if (targetFileAlreadyExists) {
			// Handle existing file case...
			let validAnotherFileBaseName = await this.generateValidBaseName(validPath);
			if (validAnotherFileBaseName != validBaseName) {
				console.warn("Unique attachments: cant rename file \n   " + filePath + "\n    to\n   " + validPath + "\n   Another file exists with the same (target) name but different content.")
				return false;
			}

			if (!this.settings.mergeTheSameAttachments) {
				console.warn("Unique attachments: cant rename file \n   " + filePath + "\n    to\n   " + validPath + "\n   Another file exists with the same (target) name and the same content. You can enable \"Delete duplicates\" setting for delete this file and merge attachments.")
				return false;
			}

			try {
				await this.app.vault.delete(file);
			} catch (e) {
				console.error("Unique attachments: cant delete duplicate file " + filePath + ".\n" + e);
				return false;
			}

			// Update references in both markdown and canvas files
			if (allNotes) {
				for (let note of allNotes) {
					if (note.endsWith('.canvas')) {
						await this.lh.updateChangedPathInCanvas(note, filePath, validPath);
					} else {
						await this.lh.updateChangedPathInNote(note, filePath, validPath);
					}
				}
			}

			console.log("Unique attachments: file content is the same in \n   " + filePath + "\n   and \n   " + validPath + "\n   Duplicates merged.")
		} else {
			try {
				await this.app.vault.rename(file, validPath);
			} catch (e) {
				console.error("Unique attachments: cant rename file \n   " + filePath + "\n   to\n   " + validPath + "   \n" + e);
				return false;
			}

			// Update references in both markdown and canvas files
			if (allNotes) {
				for (let note of allNotes) {
					if (note.endsWith('.canvas')) {
						await this.lh.updateChangedPathInCanvas(note, filePath, validPath);
					} else {
						await this.lh.updateChangedPathInNote(note, filePath, validPath);
					}
				}
			}

			console.log("Unique attachments: file renamed [from, to]:\n   " + filePath + "\n   " + validPath);
		}

		return true;
	}

	async renameAttachmentsForActiveMD(mdfile: TFile): Promise<number> {
		let renamedCount = 0;
		let currentView = this.app.workspace.activeLeaf.view;
		
		// Handle markdown files
		if (mdfile.extension === 'md') {
			let rlinks = Object.keys(this.app.metadataCache.resolvedLinks[mdfile.path]);
			let actMetadataCache = this.app.metadataCache.getFileCache(mdfile);

			for (let rlink of rlinks) {
				let file = this.app.vault.getAbstractFileByPath(rlink);
				if (!file) continue;

				let renamed = await this.renameAttachmentIfNeeded(file);
				if (renamed) renamedCount++;
			}
		}
		// Handle canvas files
		else if (mdfile.extension === 'canvas') {
			let content = await this.app.vault.read(mdfile);
			let canvasData = JSON.parse(content);

			for (let node of canvasData.nodes) {
				if (node.type === 'file' && node.file) {
					let filePath = this.lh.getFullPathForLink(node.file, mdfile.path);
					let file = this.app.vault.getAbstractFileByPath(filePath);
					if (!file) continue;

					let renamed = await this.renameAttachmentIfNeeded(file);
					if (renamed) renamedCount++;
				}
			}
		}

		return renamedCount;
	}

	saveAttachmentNameInLink(mdc: CachedMetadata, mdfile: TFile, file: TAbstractFile, baseName: string, currentView: MarkdownView) {
		let cmDoc = currentView.editor;
		if (!mdc.links) {
			return;
		}

		for (let eachLink of mdc.links) {
			if (eachLink.displayText != "" && eachLink.link != eachLink.displayText) {
				continue;
			}
			let afile = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(eachLink.link), mdfile.path);
			if (afile != null && afile.path == file.path) {
				let newlink = this.app.fileManager.generateMarkdownLink(afile, file.parent.path, "", baseName);
				// remove symbol '!'
				newlink = newlink.substring(1);
				const linkstart = eachLink.position.start;
				const linkend = eachLink.position.end;
				cmDoc.replaceRange(newlink, 
						   {line: linkstart.line, ch: linkstart.col},
						   {line: linkend.line, ch: linkend.col});
			}
		}
	}

	async renameAttachment(file: TAbstractFile, validBaseName: string): Promise<boolean> {
		let validPath = this.lh.getFilePathWithRenamedBaseName(file.path, validBaseName);

		let targetFileAlreadyExists = await this.app.vault.adapter.exists(validPath)

		if (targetFileAlreadyExists) {
			//if file content is the same in both files, one of them will be deleted			
			let validAnotherFileBaseName = await this.generateValidBaseName(validPath);
			if (validAnotherFileBaseName != validBaseName) {
				console.warn("Unique attachments: cant rename file \n   " + file.path + "\n    to\n   " + validPath + "\n   Another file exists with the same (target) name but different content.")
				return false;
			}

			if (!this.settings.mergeTheSameAttachments) {
				console.warn("Unique attachments: cant rename file \n   " + file.path + "\n    to\n   " + validPath + "\n   Another file exists with the same (target) name and the same content. You can enable \"Delte duplicates\" setting for delete this file and merge attachments.")
				return false;
			}

			try {
				// Obsidian can not replace one file to another
				let oldfile = this.app.vault.getAbstractFileByPath(validPath)
				// so just silently delete the old file 
				await this.app.vault.delete(oldfile);
				// and give the same name to the new one
				await this.app.fileManager.renameFile(file, validPath);
			} catch (e) {
				console.error("Unique attachments: cant delete duplicate file " + file.path + ".\n" + e);
				return false;
			}

			console.log("Unique attachments: file content is the same in \n   " + file.path + "\n   and \n   " + validPath + "\n   Duplicates merged.")
		} else {
			try {
				await this.app.fileManager.renameFile(file, validPath);
			} catch (e) {
				console.error("Unique attachments: cant rename file \n   " + file.path + "\n   to\n   " + validPath + "   \n" + e);
				return false;
			}

			console.log("Unique attachments: file renamed [from, to]:\n   " + file.path + "\n   " + validPath);
		}
		return true;
	}

	checkFilePathIsIgnored(filePath: string): boolean {
		for (let folder of this.settings.ignoreFolders) {
			if (filePath.startsWith(folder))
				return true;
		}
		return false;
	}

	checkFileTypeIsAllowed(filePath: string): boolean {
		for (let ext of this.settings.renameFileTypes) {
			if (filePath.endsWith("." + ext))
				return true;
		}
		return false;
	}

	async generateValidBaseName(filePath: string) {
		let file = this.lh.getFileByPath(filePath);
		let data = await this.app.vault.readBinary(file);
		const buf = Buffer.from(data);

		// var crypto = require('crypto');
		// let hash: string = crypto.createHash('md5').update(buf).digest("hex");

		let md5 = new Md5();
		md5.appendByteArray(buf);
		let hash = md5.end().toString();

		return hash;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}




