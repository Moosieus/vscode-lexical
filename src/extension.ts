import * as fs from "fs";
import { join } from "path";
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { ExtensionContext, commands, CompletionList, Uri, window, workspace } from "vscode";
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	MessageSignature
} from "vscode-languageclient/node";
import { URI } from "vscode-uri";
import Commands from "./clientCommands";
import reindexProject from "./clientCommands/reindex-project";
import restartServer from "./clientCommands/restart-server";
import Configuration from "./configuration";
import LanguageServer from "./language-server";
import Logger from "./logger";

import * as vscode from "vscode";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: ExtensionContext): Promise<void> {
	const startScriptOrReleaseFolderPath = await maybeAutoInstall(context);
	const projectDir = Configuration.getProjectDirUri(getConfig, workspace);

	if (startScriptOrReleaseFolderPath !== undefined) {
		const client = await start(startScriptOrReleaseFolderPath, projectDir);

		const registerCommand = Commands.getRegisterFunction((id, handler) => {
			context.subscriptions.push(commands.registerCommand(id, handler));
		});

		registerCommand(restartServer, { client });
		registerCommand(reindexProject, { client });
	}
}

// This method is called when your extension is deactivated
// eslint-disable-next-line @typescript-eslint/no-empty-function
export function deactivate(): void {
	// noop
}

async function maybeAutoInstall(
	context: ExtensionContext,
): Promise<string | undefined> {
	const releasePathOverride = Configuration.getReleasePathOverride(getConfig);

	if (releasePathOverride !== undefined && releasePathOverride !== "") {
		Logger.info(
			`Release override path set to "${releasePathOverride}". Skipping auto-install.`,
		);

		return releasePathOverride as string;
	}

	Logger.info("Release override path is undefined, starting auto-install.");

	return await LanguageServer.install(
		context.globalStorageUri,
		window.showErrorMessage,
	);
}

function isExecutableFile(path: fs.PathLike): boolean {
	const stat = fs.lstatSync(path);
	let hasExecuteAccess = false;
	try {
		fs.accessSync(path, fs.constants.X_OK);
		hasExecuteAccess = true;
	} catch (_e) {
		hasExecuteAccess = false;
	}
	return stat.isFile() && hasExecuteAccess;
}

async function start(
	startScriptOrReleaseFolderPath: string,
	workspaceUri: URI,
): Promise<LanguageClient> {
	Logger.info(`Starting Lexical in directory ${workspaceUri?.fsPath}`);

	const startScriptPath = isExecutableFile(startScriptOrReleaseFolderPath)
		? startScriptOrReleaseFolderPath
		: join(startScriptOrReleaseFolderPath, "start_lexical.sh");

	const serverOptions: ServerOptions = {
		command: startScriptPath,
	};

	workspace.registerTextDocumentContentProvider('embedded-content', {
		provideTextDocumentContent: uri => {
			const originalUri = uri.path.slice(1).slice(0, -4);
			const decodedUri = decodeURIComponent(originalUri);
			return virtualDocumentContents.get(decodedUri);
		}
	});

	const virtualDocumentContents = new Map<string, string>();

	const executeDelegateRequest = async (type: string | MessageSignature, params: any, content: string, language: string): Promise<any> => {
		const request = typeof type === "string" ? type : type.method;
		const originalUri = params.textDocument.uri;
	
		// Delegating requests only makes sense for text document requests, where a URI is available
		if (!originalUri) {
		  return null;
		}
	
		Logger.info(`delegate request language: "${language}"`)
		Logger.info(`delegate request content: "${content}"`)
		Logger.info(`delegate request position: "${params.position}"`)
		Logger.info(`delegate request trigger character: "${params.triggerCharacter}"`)

		virtualDocumentContents.set(originalUri, content);

		const virtualDocumentUri = `embedded-content://${language}/${encodeURIComponent(originalUri)}.${language}`;

		// Call the appropriate language service for the request, so that VS Code delegates the work accordingly
		switch (request) {
		  case "textDocument/completion":
			return vscode.commands
			  .executeCommand<CompletionList>(
				"vscode.executeCompletionItemProvider",
				vscode.Uri.parse(virtualDocumentUri),
				params.position,
				params.context.triggerCharacter,
			  )
			  .then((response) => {
				// We need to tell the server that the completion item is being delegated, so that when it receives the
				// `completionItem/resolve`, we can delegate that too
				response.items.forEach((item) => {
				  // For whatever reason, HTML completion items don't include the `kind` and that causes a failure in the
				  // editor. It might be a mistake in the delegation
				  if (
					item.documentation &&
					typeof item.documentation !== "string" &&
					"value" in item.documentation
				  ) {
					// @ts-ignore
					item.documentation.kind = "markdown";
				  }

				  // @ts-ignore
				  item.data = { ...item.data, delegateCompletion: true };
				});
	
				return response;
			  });
		  case "textDocument/hover":
			return vscode.commands.executeCommand(
			  "vscode.executeHoverProvider",
			  vscode.Uri.parse(virtualDocumentUri),
			  params.position,
			);
		  case "textDocument/definition":
			return vscode.commands.executeCommand(
			  "vscode.executeDefinitionProvider",
			  vscode.Uri.parse(virtualDocumentUri),
			  params.position,
			);
		  case "textDocument/signatureHelp":
			return vscode.commands.executeCommand(
			  "vscode.executeSignatureHelpProvider",
			  vscode.Uri.parse(virtualDocumentUri),
			  params.position,
			  params.context?.triggerCharacter,
			);
		  case "textDocument/documentHighlight":
			return vscode.commands.executeCommand(
			  "vscode.executeDocumentHighlights",
			  vscode.Uri.parse(virtualDocumentUri),
			  params.position,
			);
		  default:
			return null;
		}
	}

	const clientOptions: LanguageClientOptions = {
		outputChannel: Logger.outputChannel(),
		// Register the server for Elixir documents
		// the client will iterate through this list and chose the first matching element
		documentSelector: [
			{ language: "elixir", scheme: "file" },
			{ language: "elixir", scheme: "untitled" },
			{ language: "eex", scheme: "file" },
			{ language: "eex", scheme: "untitled" },
			{ language: "html-eex", scheme: "file" },
			{ language: "html-eex", scheme: "untitled" },
			{ language: "phoenix-heex", scheme: "file" },
			{ language: "phoenix-heex", scheme: "untitled" },
		],
		workspaceFolder: {
			index: 0,
			uri: workspaceUri,
			name: workspaceUri.path,
		},
		middleware: {
			async sendRequest(type, param, token, next) {
				try {
					return await next(type, param, token);
				} catch (error: any) {
					Logger.info(`got error code: ${error.code}`);

					if (error.code == -32900) {
						const { content, language } = JSON.parse(error.message)

						return await executeDelegateRequest(type, param, content, language);
					}

					throw error;
				}
			},
		}
	};

	const client = new LanguageClient(
		"lexical",
		"Lexical",
		serverOptions,
		clientOptions,
	);

	Logger.info(
		`Starting lexical release in "${startScriptOrReleaseFolderPath}"`,
	);

	try {
		await client.start();
	} catch (reason) {
		window.showWarningMessage(`Failed to start Lexical: ${reason}`);
	}

	return client;
}

function getConfig(section: string) {
	return workspace.getConfiguration("lexical.server").get(section);
}
