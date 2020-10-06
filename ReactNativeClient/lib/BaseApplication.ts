import Setting from 'lib/models/Setting';
import Logger, { TargetType } from 'lib/Logger';
import shim from 'lib/shim';
import BaseService from 'lib/services/BaseService';
import reducer from 'lib/reducer';
import KeychainServiceDriver from 'lib/services/keychain/KeychainServiceDriver.node';
import { _, setLocale } from 'lib/locale';

const { createStore, applyMiddleware } = require('redux');
const { defaultState, stateUtils } = require('lib/reducer');
const { JoplinDatabase } = require('lib/joplin-database.js');
const { FoldersScreenUtils } = require('lib/folders-screen-utils.js');
const { DatabaseDriverNode } = require('lib/database-driver-node.js');
const BaseModel = require('lib/BaseModel.js');
const Folder = require('lib/models/Folder.js');
const BaseItem = require('lib/models/BaseItem.js');
const Note = require('lib/models/Note.js');
const Tag = require('lib/models/Tag.js');
const { splitCommandString } = require('lib/string-utils.js');
const { reg } = require('lib/registry.js');
const { time } = require('lib/time-utils.js');
const BaseSyncTarget = require('lib/BaseSyncTarget.js');
const reduxSharedMiddleware = require('lib/components/shared/reduxSharedMiddleware');
const os = require('os');
const fs = require('fs-extra');
const JoplinError = require('lib/JoplinError');
const EventEmitter = require('events');
const syswidecas = require('syswide-cas');
const SyncTargetRegistry = require('lib/SyncTargetRegistry.js');
const SyncTargetFilesystem = require('lib/SyncTargetFilesystem.js');
const SyncTargetOneDrive = require('lib/SyncTargetOneDrive.js');
const SyncTargetOneDriveDev = require('lib/SyncTargetOneDriveDev.js');
const SyncTargetNextcloud = require('lib/SyncTargetNextcloud.js');
const SyncTargetWebDAV = require('lib/SyncTargetWebDAV.js');
const SyncTargetDropbox = require('lib/SyncTargetDropbox.js');
const SyncTargetAmazonS3 = require('lib/SyncTargetAmazonS3.js');
const EncryptionService = require('lib/services/EncryptionService');
const ResourceFetcher = require('lib/services/ResourceFetcher');
const SearchEngineUtils = require('lib/services/searchengine/SearchEngineUtils');
const SearchEngine = require('lib/services/searchengine/SearchEngine');
const RevisionService = require('lib/services/RevisionService');
const ResourceService = require('lib/services/RevisionService');
const DecryptionWorker = require('lib/services/DecryptionWorker');
const { loadKeychainServiceAndSettings } = require('lib/services/SettingUtils');
const KvStore = require('lib/services/KvStore');
const MigrationService = require('lib/services/MigrationService');
const { toSystemSlashes } = require('lib/path-utils.js');
const { setAutoFreeze } = require('immer');

// const ntpClient = require('lib/vendor/ntp-client');
// ntpClient.dgram = require('dgram');

export default class BaseApplication {

	private logger_:Logger;
	private dbLogger_:Logger;
	private eventEmitter_:any;
	private scheduleAutoAddResourcesIID_:any = null;
	private database_:any = null;

	protected showStackTraces_:boolean = false;
	protected showPromptString_:boolean = false;

	// Note: this is basically a cache of state.selectedFolderId. It should *only*
	// be derived from the state and not set directly since that would make the
	// state and UI out of sync.
	private currentFolder_:any = null;

	protected store_:any = null;

	constructor() {
		this.logger_ = new Logger();
		this.dbLogger_ = new Logger();
		this.eventEmitter_ = new EventEmitter();

		this.decryptionWorker_resourceMetadataButNotBlobDecrypted = this.decryptionWorker_resourceMetadataButNotBlobDecrypted.bind(this);
	}

	async destroy() {
		if (this.scheduleAutoAddResourcesIID_) {
			shim.clearTimeout(this.scheduleAutoAddResourcesIID_);
			this.scheduleAutoAddResourcesIID_ = null;
		}
		await ResourceFetcher.instance().destroy();
		await SearchEngine.instance().destroy();
		await DecryptionWorker.instance().destroy();
		await FoldersScreenUtils.cancelTimers();
		await BaseItem.revisionService_.cancelTimers();
		await ResourceService.instance().cancelTimers();
		await reg.cancelTimers();

		this.eventEmitter_.removeAllListeners();
		KvStore.instance_ = null;
		BaseModel.setDb(null);
		reg.setDb(null);

		BaseItem.revisionService_ = null;
		RevisionService.instance_ = null;
		ResourceService.instance_ = null;
		ResourceService.isRunningInBackground = false;
		ResourceFetcher.instance_ = null;
		EncryptionService.instance_ = null;
		DecryptionWorker.instance_ = null;

		this.logger_.info('Base application terminated...');
		this.logger_ = null;
		this.dbLogger_ = null;
		this.eventEmitter_ = null;
		this.decryptionWorker_resourceMetadataButNotBlobDecrypted = null;
	}

	logger() {
		return this.logger_;
	}

	public store() {
		return this.store_;
	}

	currentFolder() {
		return this.currentFolder_;
	}

	async refreshCurrentFolder() {
		let newFolder = null;

		if (this.currentFolder_) newFolder = await Folder.load(this.currentFolder_.id);
		if (!newFolder) newFolder = await Folder.defaultFolder();

		this.switchCurrentFolder(newFolder);
	}

	switchCurrentFolder(folder:any) {
		if (!this.hasGui()) {
			this.currentFolder_ = Object.assign({}, folder);
			Setting.setValue('activeFolderId', folder ? folder.id : '');
		} else {
			this.dispatch({
				type: 'FOLDER_SELECT',
				id: folder ? folder.id : '',
			});
		}
	}

	// Handles the initial flags passed to main script and
	// returns the remaining args.
	async handleStartFlags_(argv:string[], setDefaults:boolean = true) {
		const matched:any = {};
		argv = argv.slice(0);
		argv.splice(0, 2); // First arguments are the node executable, and the node JS file

		while (argv.length) {
			const arg = argv[0];
			const nextArg = argv.length >= 2 ? argv[1] : null;

			if (arg == '--profile') {
				if (!nextArg) throw new JoplinError(_('Usage: %s', '--profile <dir-path>'), 'flagError');
				matched.profileDir = nextArg;
				argv.splice(0, 2);
				continue;
			}

			if (arg == '--no-welcome') {
				matched.welcomeDisabled = true;
				argv.splice(0, 1);
				continue;
			}

			if (arg == '--env') {
				if (!nextArg) throw new JoplinError(_('Usage: %s', '--env <dev|prod>'), 'flagError');
				matched.env = nextArg;
				argv.splice(0, 2);
				continue;
			}

			if (arg == '--is-demo') {
				Setting.setConstant('isDemo', true);
				argv.splice(0, 1);
				continue;
			}

			if (arg == '--open-dev-tools') {
				Setting.setConstant('flagOpenDevTools', true);
				argv.splice(0, 1);
				continue;
			}

			if (arg == '--debug') {
				// Currently only handled by ElectronAppWrapper (isDebugMode property)
				argv.splice(0, 1);
				continue;
			}

			if (arg == '--update-geolocation-disabled') {
				Note.updateGeolocationEnabled_ = false;
				argv.splice(0, 1);
				continue;
			}

			if (arg == '--stack-trace-enabled') {
				this.showStackTraces_ = true;
				argv.splice(0, 1);
				continue;
			}

			if (arg == '--log-level') {
				if (!nextArg) throw new JoplinError(_('Usage: %s', '--log-level <none|error|warn|info|debug>'), 'flagError');
				matched.logLevel = Logger.levelStringToId(nextArg);
				argv.splice(0, 2);
				continue;
			}

			if (arg.indexOf('-psn') === 0) {
				// Some weird flag passed by macOS - can be ignored.
				// https://github.com/laurent22/joplin/issues/480
				// https://stackoverflow.com/questions/10242115
				argv.splice(0, 1);
				continue;
			}

			if (arg === '--enable-logging') {
				// Electron-specific flag used for debugging - ignore it
				argv.splice(0, 1);
				continue;
			}

			if (arg === '--dev-plugins') {
				Setting.setConstant('startupDevPlugins', nextArg.split(',').map(p => p.trim()));
				argv.splice(0, 2);
				continue;
			}

			if (arg.indexOf('--remote-debugging-port=') === 0) {
				// Electron-specific flag used for debugging - ignore it. Electron expects this flag in '--x=y' form, a single string.
				argv.splice(0, 1);
				continue;
			}

			if (arg === '--no-sandbox') {
				// Electron-specific flag for running the app without chrome-sandbox
				// Allows users to use it as a workaround for the electron+AppImage issue
				// https://github.com/laurent22/joplin/issues/2246
				argv.splice(0, 1);
				continue;
			}

			if (arg.length && arg[0] == '-') {
				throw new JoplinError(_('Unknown flag: %s', arg), 'flagError');
			} else {
				break;
			}
		}

		if (setDefaults) {
			if (!matched.logLevel) matched.logLevel = Logger.LEVEL_INFO;
			if (!matched.env) matched.env = 'prod';
			if (!matched.devPlugins) matched.devPlugins = [];
		}

		return {
			matched: matched,
			argv: argv,
		};
	}

	on(eventName:string, callback:Function) {
		return this.eventEmitter_.on(eventName, callback);
	}

	async exit(code = 0) {
		await Setting.saveAll();
		process.exit(code);
	}

	async refreshNotes(state:any, useSelectedNoteId:boolean = false, noteHash:string = '') {
		let parentType = state.notesParentType;
		let parentId = null;

		if (parentType === 'Folder') {
			parentId = state.selectedFolderId;
			parentType = BaseModel.TYPE_FOLDER;
		} else if (parentType === 'Tag') {
			parentId = state.selectedTagId;
			parentType = BaseModel.TYPE_TAG;
		} else if (parentType === 'Search') {
			parentId = state.selectedSearchId;
			parentType = BaseModel.TYPE_SEARCH;
		} else if (parentType === 'SmartFilter') {
			parentId = state.selectedSmartFilterId;
			parentType = BaseModel.TYPE_SMART_FILTER;
		}

		this.logger().debug('Refreshing notes:', parentType, parentId);

		const options = {
			order: stateUtils.notesOrder(state.settings),
			uncompletedTodosOnTop: Setting.value('uncompletedTodosOnTop'),
			showCompletedTodos: Setting.value('showCompletedTodos'),
			caseInsensitive: true,
		};

		const source = JSON.stringify({
			options: options,
			parentId: parentId,
		});

		let notes = [];
		let highlightedWords = [];

		if (parentId) {
			if (parentType === Folder.modelType()) {
				notes = await Note.previews(parentId, options);
			} else if (parentType === Tag.modelType()) {
				notes = await Tag.notes(parentId, options);
			} else if (parentType === BaseModel.TYPE_SEARCH) {
				const search = BaseModel.byId(state.searches, parentId);
				notes = await SearchEngineUtils.notesForQuery(search.query_pattern);
				const parsedQuery = await SearchEngine.instance().parseQuery(search.query_pattern);
				highlightedWords = SearchEngine.instance().allParsedQueryTerms(parsedQuery);
			} else if (parentType === BaseModel.TYPE_SMART_FILTER) {
				notes = await Note.previews(parentId, options);
			}
		}

		this.store().dispatch({
			type: 'SET_HIGHLIGHTED',
			words: highlightedWords,
		});

		this.store().dispatch({
			type: 'NOTE_UPDATE_ALL',
			notes: notes,
			notesSource: source,
		});

		if (useSelectedNoteId) {
			this.store().dispatch({
				type: 'NOTE_SELECT',
				id: state.selectedNoteIds && state.selectedNoteIds.length ? state.selectedNoteIds[0] : null,
				hash: noteHash,
			});
		} else {
			const lastSelectedNoteIds = stateUtils.lastSelectedNoteIds(state);
			const foundIds = [];
			for (let i = 0; i < lastSelectedNoteIds.length; i++) {
				const noteId = lastSelectedNoteIds[i];
				let found = false;
				for (let j = 0; j < notes.length; j++) {
					if (notes[j].id === noteId) {
						found = true;
						break;
					}
				}
				if (found) foundIds.push(noteId);
			}

			let selectedNoteId = null;
			if (foundIds.length) {
				selectedNoteId = foundIds[0];
			} else {
				selectedNoteId = notes.length ? notes[0].id : null;
			}

			this.store().dispatch({
				type: 'NOTE_SELECT',
				id: selectedNoteId,
			});
		}
	}

	resourceFetcher_downloadComplete(event:any) {
		if (event.encrypted) {
			DecryptionWorker.instance().scheduleStart();
		}
	}

	async decryptionWorker_resourceMetadataButNotBlobDecrypted() {
		ResourceFetcher.instance().scheduleAutoAddResources();
	}

	reducerActionToString(action:any) {
		const o = [action.type];
		if ('id' in action) o.push(action.id);
		if ('noteId' in action) o.push(action.noteId);
		if ('folderId' in action) o.push(action.folderId);
		if ('tagId' in action) o.push(action.tagId);
		if ('tag' in action) o.push(action.tag.id);
		if ('folder' in action) o.push(action.folder.id);
		if ('notesSource' in action) o.push(JSON.stringify(action.notesSource));
		return o.join(', ');
	}

	hasGui() {
		return false;
	}

	uiType() {
		return this.hasGui() ? 'gui' : 'cli';
	}

	generalMiddlewareFn() {
		const middleware = (store:any) => (next:any) => (action:any) => {
			return this.generalMiddleware(store, next, action);
		};

		return middleware;
	}

	async applySettingsSideEffects(action:any = null) {
		const sideEffects:any = {
			'dateFormat': async () => {
				time.setLocale(Setting.value('locale'));
				time.setDateFormat(Setting.value('dateFormat'));
				time.setTimeFormat(Setting.value('timeFormat'));
			},
			'net.ignoreTlsErrors': async () => {
				process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = Setting.value('net.ignoreTlsErrors') ? '0' : '1';
			},
			'net.customCertificates': async () => {
				const caPaths = Setting.value('net.customCertificates').split(',');
				for (let i = 0; i < caPaths.length; i++) {
					const f = caPaths[i].trim();
					if (!f) continue;
					syswidecas.addCAs(f);
				}
			},
			'encryption.enabled': async () => {
				if (this.hasGui()) {
					await EncryptionService.instance().loadMasterKeysFromSettings();
					DecryptionWorker.instance().scheduleStart();
					const loadedMasterKeyIds = EncryptionService.instance().loadedMasterKeyIds();

					this.dispatch({
						type: 'MASTERKEY_REMOVE_NOT_LOADED',
						ids: loadedMasterKeyIds,
					});

					// Schedule a sync operation so that items that need to be encrypted
					// are sent to sync target.
					reg.scheduleSync();
				}
			},
			'sync.interval': async () => {
				if (this.hasGui()) reg.setupRecurrentSync();
			},
		};

		sideEffects['timeFormat'] = sideEffects['dateFormat'];
		sideEffects['locale'] = sideEffects['dateFormat'];
		sideEffects['encryption.activeMasterKeyId'] = sideEffects['encryption.enabled'];
		sideEffects['encryption.passwordCache'] = sideEffects['encryption.enabled'];

		if (action) {
			const effect = sideEffects[action.key];
			if (effect) await effect();
		} else {
			for (const key in sideEffects) {
				await sideEffects[key]();
			}
		}
	}

	async generalMiddleware(store:any, next:any, action:any) {
		// this.logger().debug('Reducer action', this.reducerActionToString(action));

		const result = next(action);
		const newState = store.getState();
		let refreshNotes = false;
		let refreshFolders:boolean | string = false;
		// let refreshTags = false;
		let refreshNotesUseSelectedNoteId = false;
		let refreshNotesHash = '';

		await reduxSharedMiddleware(store, next, action);

		if (this.hasGui() && ['NOTE_UPDATE_ONE', 'NOTE_DELETE', 'FOLDER_UPDATE_ONE', 'FOLDER_DELETE'].indexOf(action.type) >= 0) {
			if (!(await reg.syncTarget().syncStarted())) reg.scheduleSync(30 * 1000, { syncSteps: ['update_remote', 'delete_remote'] });
			SearchEngine.instance().scheduleSyncTables();
		}

		// Don't add FOLDER_UPDATE_ALL as refreshFolders() is calling it too, which
		// would cause the sidebar to refresh all the time.
		if (this.hasGui() && ['FOLDER_UPDATE_ONE'].indexOf(action.type) >= 0) {
			refreshFolders = true;
		}

		if (action.type == 'HISTORY_BACKWARD' || action.type == 'HISTORY_FORWARD') {
			refreshNotes = true;
			refreshNotesUseSelectedNoteId = true;
		}

		if (action.type == 'HISTORY_BACKWARD' || action.type == 'HISTORY_FORWARD' || action.type == 'FOLDER_SELECT' || action.type === 'FOLDER_DELETE' || action.type === 'FOLDER_AND_NOTE_SELECT' || (action.type === 'SEARCH_UPDATE' && newState.notesParentType === 'Folder')) {
			Setting.setValue('activeFolderId', newState.selectedFolderId);
			this.currentFolder_ = newState.selectedFolderId ? await Folder.load(newState.selectedFolderId) : null;
			refreshNotes = true;

			if (action.type === 'FOLDER_AND_NOTE_SELECT') {
				refreshNotesUseSelectedNoteId = true;
				refreshNotesHash = action.hash;
			}
		}

		if (this.hasGui() && (action.type == 'NOTE_IS_INSERTING_NOTES' && !action.value)) {
			refreshNotes = true;
		}

		if (this.hasGui() && ((action.type == 'SETTING_UPDATE_ONE' && action.key == 'uncompletedTodosOnTop') || action.type == 'SETTING_UPDATE_ALL')) {
			refreshNotes = true;
		}

		if (this.hasGui() && ((action.type == 'SETTING_UPDATE_ONE' && action.key == 'showCompletedTodos') || action.type == 'SETTING_UPDATE_ALL')) {
			refreshNotes = true;
		}

		if (this.hasGui() && ((action.type == 'SETTING_UPDATE_ONE' && action.key.indexOf('notes.sortOrder') === 0) || action.type == 'SETTING_UPDATE_ALL')) {
			refreshNotes = true;
		}

		if (action.type == 'SMART_FILTER_SELECT') {
			refreshNotes = true;
			refreshNotesUseSelectedNoteId = true;
		}

		// Should refresh the notes when:
		// - A tag is selected, to show the notes for that tag
		// - When a tag is updated so that when searching by tags, the search results are updated
		// https://github.com/laurent22/joplin/issues/3754
		if (['TAG_SELECT', 'TAG_DELETE', 'TAG_UPDATE_ONE', 'NOTE_TAG_REMOVE'].includes(action.type)) {
			refreshNotes = true;
		}

		if (action.type == 'SEARCH_SELECT' || action.type === 'SEARCH_DELETE') {
			refreshNotes = true;
		}

		if (action.type == 'NOTE_TAG_REMOVE') {
			if (newState.notesParentType === 'Tag' && newState.selectedTagId === action.item.id) {
				if (newState.notes.length === newState.selectedNoteIds.length) {
					await this.refreshCurrentFolder();
					refreshNotesUseSelectedNoteId = true;
				}
				refreshNotes = true;
			}
		}

		if (refreshNotes) {
			await this.refreshNotes(newState, refreshNotesUseSelectedNoteId, refreshNotesHash);
		}

		if (action.type === 'NOTE_UPDATE_ONE' || action.type === 'NOTE_DELETE') {
			refreshFolders = true;
		}

		if (this.hasGui() && action.type == 'SETTING_UPDATE_ALL') {
			refreshFolders = 'now';
		}

		if (this.hasGui() && action.type == 'SETTING_UPDATE_ONE' && (
			action.key.indexOf('folders.sortOrder') === 0 ||
			action.key == 'showNoteCounts' ||
			action.key == 'showCompletedTodos')) {
			refreshFolders = 'now';
		}

		if (this.hasGui() && action.type === 'SYNC_GOT_ENCRYPTED_ITEM') {
			DecryptionWorker.instance().scheduleStart();
		}

		if (this.hasGui() && action.type === 'SYNC_CREATED_OR_UPDATED_RESOURCE') {
			ResourceFetcher.instance().autoAddResources();
		}

		if (action.type == 'SETTING_UPDATE_ONE') {
			await this.applySettingsSideEffects(action);
		} else if (action.type == 'SETTING_UPDATE_ALL') {
			await this.applySettingsSideEffects();
		}

		if (refreshFolders) {
			if (refreshFolders === 'now') {
				await FoldersScreenUtils.refreshFolders();
			} else {
				await FoldersScreenUtils.scheduleRefreshFolders();
			}
		}
		return result;
	}

	dispatch(action:any) {
		if (this.store()) return this.store().dispatch(action);
	}

	reducer(state:any = defaultState, action:any) {
		return reducer(state, action);
	}

	initRedux() {
		this.store_ = createStore(this.reducer, applyMiddleware(this.generalMiddlewareFn()));
		BaseModel.dispatch = this.store().dispatch;
		FoldersScreenUtils.dispatch = this.store().dispatch;
		reg.dispatch = this.store().dispatch;
		BaseSyncTarget.dispatch = this.store().dispatch;
		DecryptionWorker.instance().dispatch = this.store().dispatch;
		ResourceFetcher.instance().dispatch = this.store().dispatch;
	}

	deinitRedux() {
		this.store_ = null;
		BaseModel.dispatch = function() {};
		FoldersScreenUtils.dispatch = function() {};
		reg.dispatch = function() {};
		BaseSyncTarget.dispatch = function() {};
		DecryptionWorker.instance().dispatch = function() {};
		ResourceFetcher.instance().dispatch = function() {};
	}

	async readFlagsFromFile(flagPath:string) {
		if (!fs.existsSync(flagPath)) return {};
		let flagContent = fs.readFileSync(flagPath, 'utf8');
		if (!flagContent) return {};

		flagContent = flagContent.trim();

		let flags = splitCommandString(flagContent);
		flags.splice(0, 0, 'cmd');
		flags.splice(0, 0, 'node');

		flags = await this.handleStartFlags_(flags, false);

		return flags.matched;
	}

	determineProfileDir(initArgs:any) {
		let output = '';

		if (initArgs.profileDir) {
			output = initArgs.profileDir;
		} else if (process && process.env && process.env.PORTABLE_EXECUTABLE_DIR) {
			output = `${process.env.PORTABLE_EXECUTABLE_DIR}/JoplinProfile`;
		} else {
			output = `${os.homedir()}/.config/${Setting.value('appName')}`;
		}

		return toSystemSlashes(output, 'linux');
	}

	async start(argv:string[]):Promise<any> {
		const startFlags = await this.handleStartFlags_(argv);

		argv = startFlags.argv;
		let initArgs = startFlags.matched;
		if (argv.length) this.showPromptString_ = false;

		let appName = initArgs.env == 'dev' ? 'joplindev' : 'joplin';
		if (Setting.value('appId').indexOf('-desktop') >= 0) appName += '-desktop';
		Setting.setConstant('appName', appName);

		// https://immerjs.github.io/immer/docs/freezing
		setAutoFreeze(initArgs.env === 'dev');

		const profileDir = this.determineProfileDir(initArgs);
		const resourceDirName = 'resources';
		const resourceDir = `${profileDir}/${resourceDirName}`;
		const tempDir = `${profileDir}/tmp`;

		Setting.setConstant('env', initArgs.env);
		Setting.setConstant('profileDir', profileDir);
		Setting.setConstant('templateDir', `${profileDir}/templates`);
		Setting.setConstant('resourceDirName', resourceDirName);
		Setting.setConstant('resourceDir', resourceDir);
		Setting.setConstant('tempDir', tempDir);
		Setting.setConstant('pluginDir', `${profileDir}/plugins`);

		SyncTargetRegistry.addClass(SyncTargetFilesystem);
		SyncTargetRegistry.addClass(SyncTargetOneDrive);
		if (Setting.value('env') === 'dev') SyncTargetRegistry.addClass(SyncTargetOneDriveDev);
		SyncTargetRegistry.addClass(SyncTargetNextcloud);
		SyncTargetRegistry.addClass(SyncTargetWebDAV);
		SyncTargetRegistry.addClass(SyncTargetDropbox);
		SyncTargetRegistry.addClass(SyncTargetAmazonS3);

		try {
			await shim.fsDriver().remove(tempDir);
		} catch (error) {
			// Can't do anything in this case, not even log, since the logger
			// is not yet ready. But normally it's not an issue if the temp
			// dir cannot be deleted.
		}

		await fs.mkdirp(profileDir, 0o755);
		await fs.mkdirp(resourceDir, 0o755);
		await fs.mkdirp(tempDir, 0o755);

		// Clean up any remaining watched files (they start with "edit-")
		await shim.fsDriver().removeAllThatStartWith(profileDir, 'edit-');

		const extraFlags = await this.readFlagsFromFile(`${profileDir}/flags.txt`);
		initArgs = Object.assign(initArgs, extraFlags);

		this.logger_.addTarget(TargetType.File, { path: `${profileDir}/log.txt` });
		this.logger_.setLevel(initArgs.logLevel);

		reg.setLogger(this.logger_);
		reg.dispatch = () => {};

		BaseService.logger_ = this.logger_;
		// require('lib/ntpDate').setLogger(reg.logger());

		this.dbLogger_.addTarget(TargetType.File, { path: `${profileDir}/log-database.txt` });
		this.dbLogger_.setLevel(initArgs.logLevel);

		if (Setting.value('appType') === 'desktop') {
			this.logger_.addTarget(TargetType.Console, { level: Logger.LEVEL_WARN });
			this.dbLogger_.addTarget(TargetType.Console, { level: Logger.LEVEL_WARN });
		}

		if (Setting.value('env') === 'dev') {
			this.dbLogger_.setLevel(Logger.LEVEL_INFO);
		}

		this.logger_.info(`Profile directory: ${profileDir}`);

		this.database_ = new JoplinDatabase(new DatabaseDriverNode());
		this.database_.setLogExcludedQueryTypes(['SELECT']);
		this.database_.setLogger(this.dbLogger_);

		if (Setting.value('env') === 'dev') {
			if (shim.isElectron()) {
				this.database_.extensionToLoad = './lib/sql-extensions/spellfix';
			}
		} else {
			if (shim.isElectron()) {
				if (shim.isWindows()) {
					const appDir = process.execPath.substring(0, process.execPath.lastIndexOf('\\'));
					this.database_.extensionToLoad = `${appDir}/usr/lib/spellfix`;
				} else {
					const appDir = process.execPath.substring(0, process.execPath.lastIndexOf('/'));
					this.database_.extensionToLoad = `${appDir}/usr/lib/spellfix`;
				}
			}
		}

		await this.database_.open({ name: `${profileDir}/database.sqlite` });

		// if (Setting.value('env') === 'dev') await this.database_.clearForTesting();

		reg.setDb(this.database_);
		BaseModel.setDb(this.database_);

		await loadKeychainServiceAndSettings(KeychainServiceDriver);

		this.logger_.info(`Client ID: ${Setting.value('clientId')}`);

		if (Setting.value('firstStart')) {
			const locale = shim.detectAndSetLocale(Setting);
			reg.logger().info(`First start: detected locale as ${locale}`);

			if (Setting.value('env') === 'dev') {
				Setting.setValue('showTrayIcon', 0);
				Setting.setValue('autoUpdateEnabled', 0);
				Setting.setValue('sync.interval', 3600);
			}

			Setting.setValue('firstStart', 0);
		} else {
			setLocale(Setting.value('locale'));
		}

		// if (Setting.value('db.fuzzySearchEnabled') === -1) {
		// 	const fuzzySearchEnabled = await this.database_.fuzzySearchEnabled();
		// 	Setting.setValue('db.fuzzySearchEnabled', fuzzySearchEnabled ? 1 : 0);
		// }

		// // Always disable on CLI because building and packaging the extension is not working
		// // and is too error-prone - requires gcc on the machine, or we should package the .so
		// // and dylib files, but it's not sure it would work everywhere if not built from
		// // source on the target machine.
		// if (Setting.value('appType') !== 'desktop') {
		// 	Setting.setValue('db.fuzzySearchEnabled', 0);
		// }

		// For now always disable fuzzy search due to performance issues:
		// https://discourse.joplinapp.org/t/1-1-4-keyboard-locks-up-while-typing/11231/11
		// https://discourse.joplinapp.org/t/serious-lagging-when-there-are-tens-of-thousands-of-notes/11215/23
		Setting.setValue('db.fuzzySearchEnabled', 0);

		if (Setting.value('encryption.shouldReencrypt') < 0) {
			// We suggest re-encryption if the user has at least one notebook
			// and if encryption is enabled. This code runs only when shouldReencrypt = -1
			// which can be set by a maintenance script for example.
			const folderCount = await Folder.count();
			const itShould = Setting.value('encryption.enabled') && !!folderCount ? Setting.SHOULD_REENCRYPT_YES : Setting.SHOULD_REENCRYPT_NO;
			Setting.setValue('encryption.shouldReencrypt', itShould);
		}

		if ('welcomeDisabled' in initArgs) Setting.setValue('welcome.enabled', !initArgs.welcomeDisabled);

		if (!Setting.value('api.token')) {
			EncryptionService.instance()
				.randomHexString(64)
				.then((token:string) => {
					Setting.setValue('api.token', token);
				});
		}

		time.setDateFormat(Setting.value('dateFormat'));
		time.setTimeFormat(Setting.value('timeFormat'));

		BaseItem.revisionService_ = RevisionService.instance();

		KvStore.instance().setDb(reg.db());

		EncryptionService.instance().setLogger(this.logger_);
		BaseItem.encryptionService_ = EncryptionService.instance();
		DecryptionWorker.instance().setLogger(this.logger_);
		DecryptionWorker.instance().setEncryptionService(EncryptionService.instance());
		DecryptionWorker.instance().setKvStore(KvStore.instance());
		await EncryptionService.instance().loadMasterKeysFromSettings();
		DecryptionWorker.instance().on('resourceMetadataButNotBlobDecrypted', this.decryptionWorker_resourceMetadataButNotBlobDecrypted);

		ResourceFetcher.instance().setFileApi(() => {
			return reg.syncTarget().fileApi();
		});
		ResourceFetcher.instance().setLogger(this.logger_);
		ResourceFetcher.instance().on('downloadComplete', this.resourceFetcher_downloadComplete);
		ResourceFetcher.instance().start();

		SearchEngine.instance().setDb(reg.db());
		SearchEngine.instance().setLogger(reg.logger());
		SearchEngine.instance().scheduleSyncTables();

		const currentFolderId = Setting.value('activeFolderId');
		let currentFolder = null;
		if (currentFolderId) currentFolder = await Folder.load(currentFolderId);
		if (!currentFolder) currentFolder = await Folder.defaultFolder();
		Setting.setValue('activeFolderId', currentFolder ? currentFolder.id : '');

		await MigrationService.instance().run();

		return argv;
	}
}