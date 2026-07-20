export namespace db {
	
	export class Column {
	    name: string;
	    dataType: string;
	    nullable: boolean;
	    isPrimaryKey: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Column(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.dataType = source["dataType"];
	        this.nullable = source["nullable"];
	        this.isPrimaryKey = source["isPrimaryKey"];
	    }
	}
	export class ForeignKey {
	    column: string;
	    referencedTable: string;
	    referencedColumn: string;
	
	    static createFrom(source: any = {}) {
	        return new ForeignKey(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.column = source["column"];
	        this.referencedTable = source["referencedTable"];
	        this.referencedColumn = source["referencedColumn"];
	    }
	}
	export class Function {
	    schema?: string;
	    name: string;
	    returnType?: string;
	    oid?: number;
	
	    static createFrom(source: any = {}) {
	        return new Function(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.name = source["name"];
	        this.returnType = source["returnType"];
	        this.oid = source["oid"];
	    }
	}
	export class Package {
	    schema?: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new Package(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.name = source["name"];
	    }
	}
	export class Procedure {
	    schema?: string;
	    name: string;
	    oid?: number;
	
	    static createFrom(source: any = {}) {
	        return new Procedure(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.name = source["name"];
	        this.oid = source["oid"];
	    }
	}
	export class RedisFieldValue {
	    field: string;
	    value: string;
	
	    static createFrom(source: any = {}) {
	        return new RedisFieldValue(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.field = source["field"];
	        this.value = source["value"];
	    }
	}
	export class RedisKeyEntry {
	    key: string;
	    type: string;
	
	    static createFrom(source: any = {}) {
	        return new RedisKeyEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.type = source["type"];
	    }
	}
	export class RedisKeyExport {
	    key: string;
	    type: string;
	    ttlSeconds: number;
	    value: any;
	
	    static createFrom(source: any = {}) {
	        return new RedisKeyExport(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.type = source["type"];
	        this.ttlSeconds = source["ttlSeconds"];
	        this.value = source["value"];
	    }
	}
	export class RedisKeyInfo {
	    key: string;
	    type: string;
	    ttlSeconds: number;
	    sizeBytes?: number;
	
	    static createFrom(source: any = {}) {
	        return new RedisKeyInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.type = source["type"];
	        this.ttlSeconds = source["ttlSeconds"];
	        this.sizeBytes = source["sizeBytes"];
	    }
	}
	export class RedisScanPage {
	    keys: RedisKeyEntry[];
	    cursor?: string;
	
	    static createFrom(source: any = {}) {
	        return new RedisScanPage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.keys = this.convertValues(source["keys"], RedisKeyEntry);
	        this.cursor = source["cursor"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RedisScoredMember {
	    member: string;
	    score: number;
	
	    static createFrom(source: any = {}) {
	        return new RedisScoredMember(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.member = source["member"];
	        this.score = source["score"];
	    }
	}
	export class RedisStats {
	    totalKeys: number;
	    usedMemoryBytes: number;
	
	    static createFrom(source: any = {}) {
	        return new RedisStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.totalKeys = source["totalKeys"];
	        this.usedMemoryBytes = source["usedMemoryBytes"];
	    }
	}
	export class RedisStreamEntry {
	    id: string;
	    fields: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new RedisStreamEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.fields = source["fields"];
	    }
	}
	export class RedisValue {
	    type: string;
	    stringVal?: string;
	    hashPairs?: RedisFieldValue[];
	    listItems?: string[];
	    setMembers?: string[];
	    zsetItems?: RedisScoredMember[];
	    streamEntries?: RedisStreamEntry[];
	    cursor?: string;
	
	    static createFrom(source: any = {}) {
	        return new RedisValue(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.stringVal = source["stringVal"];
	        this.hashPairs = this.convertValues(source["hashPairs"], RedisFieldValue);
	        this.listItems = source["listItems"];
	        this.setMembers = source["setMembers"];
	        this.zsetItems = this.convertValues(source["zsetItems"], RedisScoredMember);
	        this.streamEntries = this.convertValues(source["streamEntries"], RedisStreamEntry);
	        this.cursor = source["cursor"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Trigger {
	    schema?: string;
	    name: string;
	    table?: string;
	    oid?: number;
	
	    static createFrom(source: any = {}) {
	        return new Trigger(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.name = source["name"];
	        this.table = source["table"];
	        this.oid = source["oid"];
	    }
	}
	export class Table {
	    schema?: string;
	    name: string;
	    columns: Column[];
	    foreignKeys: ForeignKey[];
	
	    static createFrom(source: any = {}) {
	        return new Table(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.name = source["name"];
	        this.columns = this.convertValues(source["columns"], Column);
	        this.foreignKeys = this.convertValues(source["foreignKeys"], ForeignKey);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SchemaMetadata {
	    tables: Table[];
	    procedures?: Procedure[];
	    functions?: Function[];
	    triggers?: Trigger[];
	    packages?: Package[];
	
	    static createFrom(source: any = {}) {
	        return new SchemaMetadata(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.tables = this.convertValues(source["tables"], Table);
	        this.procedures = this.convertValues(source["procedures"], Procedure);
	        this.functions = this.convertValues(source["functions"], Function);
	        this.triggers = this.convertValues(source["triggers"], Trigger);
	        this.packages = this.convertValues(source["packages"], Package);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	

}

export namespace explain {
	
	export class PlanNode {
	    operation: string;
	    objectName?: string;
	    cost?: number;
	    rows?: number;
	    actualTimeMs?: number;
	    isFullScan?: boolean;
	    detail?: string;
	    children?: PlanNode[];
	
	    static createFrom(source: any = {}) {
	        return new PlanNode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.operation = source["operation"];
	        this.objectName = source["objectName"];
	        this.cost = source["cost"];
	        this.rows = source["rows"];
	        this.actualTimeMs = source["actualTimeMs"];
	        this.isFullScan = source["isFullScan"];
	        this.detail = source["detail"];
	        this.children = this.convertValues(source["children"], PlanNode);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Plan {
	    root?: PlanNode;
	    rawText: string;
	    durationMs?: number;
	
	    static createFrom(source: any = {}) {
	        return new Plan(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = this.convertValues(source["root"], PlanNode);
	        this.rawText = source["rawText"];
	        this.durationMs = source["durationMs"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace main {
	
	export class ConnectionEditInfo {
	    name: string;
	    dbType: string;
	    params: Record<string, string>;
	    color: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionEditInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.dbType = source["dbType"];
	        this.params = source["params"];
	        this.color = source["color"];
	    }
	}
	export class ConnectionInput {
	    name: string;
	    dbType: string;
	    params: Record<string, string>;
	    color: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.dbType = source["dbType"];
	        this.params = source["params"];
	        this.color = source["color"];
	    }
	}
	export class FileContent {
	    path: string;
	    content: string;
	
	    static createFrom(source: any = {}) {
	        return new FileContent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	    }
	}
	export class SftpEndpointInput {
	    local: boolean;
	    connId: string;
	
	    static createFrom(source: any = {}) {
	        return new SftpEndpointInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.local = source["local"];
	        this.connId = source["connId"];
	    }
	}
	export class SftpTransferInput {
	    transferId: string;
	    src: SftpEndpointInput;
	    dst: SftpEndpointInput;
	    dstDir: string;
	    items: sftpx.Item[];
	
	    static createFrom(source: any = {}) {
	        return new SftpTransferInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.transferId = source["transferId"];
	        this.src = this.convertValues(source["src"], SftpEndpointInput);
	        this.dst = this.convertValues(source["dst"], SftpEndpointInput);
	        this.dstDir = source["dstDir"];
	        this.items = this.convertValues(source["items"], sftpx.Item);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace sftpx {
	
	export class FileEntry {
	    name: string;
	    path: string;
	    size: number;
	    isDir: boolean;
	    mode: string;
	    modTime: number;
	
	    static createFrom(source: any = {}) {
	        return new FileEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.size = source["size"];
	        this.isDir = source["isDir"];
	        this.mode = source["mode"];
	        this.modTime = source["modTime"];
	    }
	}
	export class Item {
	    path: string;
	    isDir: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Item(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.isDir = source["isDir"];
	    }
	}
	export class PermInfo {
	    path: string;
	    mode: number;
	    isDir: boolean;
	    owner: string;
	    group: string;
	
	    static createFrom(source: any = {}) {
	        return new PermInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.mode = source["mode"];
	        this.isDir = source["isDir"];
	        this.owner = source["owner"];
	        this.group = source["group"];
	    }
	}

}

export namespace updatecheck {
	
	export class Info {
	    available: boolean;
	    current: string;
	    latest: string;
	    releaseUrl: string;
	
	    static createFrom(source: any = {}) {
	        return new Info(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.available = source["available"];
	        this.current = source["current"];
	        this.latest = source["latest"];
	        this.releaseUrl = source["releaseUrl"];
	    }
	}

}

export namespace vault {
	
	export class ConnectionSummary {
	    id: string;
	    name: string;
	    dbType: string;
	    createdAt: number;
	    metadataSchemas: string[];
	    color?: string;
	    folderId?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.dbType = source["dbType"];
	        this.createdAt = source["createdAt"];
	        this.metadataSchemas = source["metadataSchemas"];
	        this.color = source["color"];
	        this.folderId = source["folderId"];
	    }
	}
	export class ExplainHistoryEntry {
	    id: string;
	    connectionId: string;
	    sqlText: string;
	    analyze: boolean;
	    plan: explain.Plan;
	    createdAt: number;
	
	    static createFrom(source: any = {}) {
	        return new ExplainHistoryEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.connectionId = source["connectionId"];
	        this.sqlText = source["sqlText"];
	        this.analyze = source["analyze"];
	        this.plan = this.convertValues(source["plan"], explain.Plan);
	        this.createdAt = source["createdAt"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Folder {
	    id: string;
	    name: string;
	    parentId?: string;
	    sortOrder: number;
	    createdAt: number;
	    scope: string;
	
	    static createFrom(source: any = {}) {
	        return new Folder(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.parentId = source["parentId"];
	        this.sortOrder = source["sortOrder"];
	        this.createdAt = source["createdAt"];
	        this.scope = source["scope"];
	    }
	}
	export class HistoryEntry {
	    id: string;
	    connectionId: string;
	    sqlText: string;
	    status: string;
	    rowsAffected: number;
	    durationMs: number;
	    errorMessage?: string;
	    executedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new HistoryEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.connectionId = source["connectionId"];
	        this.sqlText = source["sqlText"];
	        this.status = source["status"];
	        this.rowsAffected = source["rowsAffected"];
	        this.durationMs = source["durationMs"];
	        this.errorMessage = source["errorMessage"];
	        this.executedAt = source["executedAt"];
	    }
	}
	export class OpenTabInfo {
	    path: string;
	    connId?: string;
	    language?: string;
	    kind?: string;
	
	    static createFrom(source: any = {}) {
	        return new OpenTabInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.connId = source["connId"];
	        this.language = source["language"];
	        this.kind = source["kind"];
	    }
	}
	export class RecentFile {
	    path: string;
	    openedAt: number;
	
	    static createFrom(source: any = {}) {
	        return new RecentFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.openedAt = source["openedAt"];
	    }
	}
	export class Settings {
	    theme: string;
	    openTabs: OpenTabInfo[];
	    sidebarCollapsed: boolean;
	    editorHeight: number;
	    rememberMasterKey: boolean;
	    editorTheme: string;
	    collapsedSidebarModules: string[];
	    sshTerminalTheme: string;
	    autoBackupEnabled: boolean;
	    autoBackupIntervalHours: number;
	    autoBackupPath: string;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.theme = source["theme"];
	        this.openTabs = this.convertValues(source["openTabs"], OpenTabInfo);
	        this.sidebarCollapsed = source["sidebarCollapsed"];
	        this.editorHeight = source["editorHeight"];
	        this.rememberMasterKey = source["rememberMasterKey"];
	        this.editorTheme = source["editorTheme"];
	        this.collapsedSidebarModules = source["collapsedSidebarModules"];
	        this.sshTerminalTheme = source["sshTerminalTheme"];
	        this.autoBackupEnabled = source["autoBackupEnabled"];
	        this.autoBackupIntervalHours = source["autoBackupIntervalHours"];
	        this.autoBackupPath = source["autoBackupPath"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SshSnippet {
	    id: string;
	    name: string;
	    script: string;
	    folderId?: string;
	    createdAt: number;
	
	    static createFrom(source: any = {}) {
	        return new SshSnippet(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.script = source["script"];
	        this.folderId = source["folderId"];
	        this.createdAt = source["createdAt"];
	    }
	}

}

