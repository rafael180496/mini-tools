export namespace agentchat {
	
	export class ToolCall {
	    name: string;
	    input: string;
	    summary: string;
	    detail: string;
	
	    static createFrom(source: any = {}) {
	        return new ToolCall(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.input = source["input"];
	        this.summary = source["summary"];
	        this.detail = source["detail"];
	    }
	}
	export class PastTurn {
	    role: string;
	    text: string;
	    tools: ToolCall[];
	
	    static createFrom(source: any = {}) {
	        return new PastTurn(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.role = source["role"];
	        this.text = source["text"];
	        this.tools = this.convertValues(source["tools"], ToolCall);
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

export namespace agentctx {
	
	export class Instruction {
	    file: string;
	    path: string;
	    present: boolean;
	    size: number;
	    agents: string[];
	
	    static createFrom(source: any = {}) {
	        return new Instruction(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.file = source["file"];
	        this.path = source["path"];
	        this.present = source["present"];
	        this.size = source["size"];
	        this.agents = source["agents"];
	    }
	}
	export class Entry {
	    name: string;
	    description: string;
	    path: string;
	    scope: string;
	
	    static createFrom(source: any = {}) {
	        return new Entry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	        this.path = source["path"];
	        this.scope = source["scope"];
	    }
	}
	export class Context {
	    skills: Entry[];
	    agents: Entry[];
	    commands: Entry[];
	    instructions: Instruction[];
	
	    static createFrom(source: any = {}) {
	        return new Context(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.skills = this.convertValues(source["skills"], Entry);
	        this.agents = this.convertValues(source["agents"], Entry);
	        this.commands = this.convertValues(source["commands"], Entry);
	        this.instructions = this.convertValues(source["instructions"], Instruction);
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

export namespace agentmodels {
	
	export class Model {
	    id: string;
	    label: string;
	    description: string;
	    efforts: string[];
	
	    static createFrom(source: any = {}) {
	        return new Model(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.description = source["description"];
	        this.efforts = source["efforts"];
	    }
	}
	export class Catalog {
	    models: Model[];
	    efforts: string[];
	
	    static createFrom(source: any = {}) {
	        return new Catalog(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.models = this.convertValues(source["models"], Model);
	        this.efforts = source["efforts"];
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

export namespace agentplan {
	
	export class Plan {
	    agent: string;
	    known: boolean;
	    label: string;
	    detail: string;
	    note: string;
	
	    static createFrom(source: any = {}) {
	        return new Plan(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.agent = source["agent"];
	        this.known = source["known"];
	        this.label = source["label"];
	        this.detail = source["detail"];
	        this.note = source["note"];
	    }
	}

}

export namespace agents {
	
	export class Agent {
	    id: string;
	    label: string;
	    vendor: string;
	    command: string;
	    defaultCommand: string;
	    path: string;
	    available: boolean;
	    keyEnv: string;
	    hasKey: boolean;
	    loginHint: string;
	    note: string;
	    docsUrl: string;
	
	    static createFrom(source: any = {}) {
	        return new Agent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.vendor = source["vendor"];
	        this.command = source["command"];
	        this.defaultCommand = source["defaultCommand"];
	        this.path = source["path"];
	        this.available = source["available"];
	        this.keyEnv = source["keyEnv"];
	        this.hasKey = source["hasKey"];
	        this.loginHint = source["loginHint"];
	        this.note = source["note"];
	        this.docsUrl = source["docsUrl"];
	    }
	}

}

export namespace agentusage {
	
	export class Activity {
	    conversations: number;
	    steps: number;
	    repoConversations: number;
	    repoSteps: number;
	    lastUsed: string;
	
	    static createFrom(source: any = {}) {
	        return new Activity(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.conversations = source["conversations"];
	        this.steps = source["steps"];
	        this.repoConversations = source["repoConversations"];
	        this.repoSteps = source["repoSteps"];
	        this.lastUsed = source["lastUsed"];
	    }
	}
	export class Bucket {
	    key: string;
	    total: number;
	    percent: number;
	    messages: number;
	
	    static createFrom(source: any = {}) {
	        return new Bucket(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.total = source["total"];
	        this.percent = source["percent"];
	        this.messages = source["messages"];
	    }
	}
	export class Totals {
	    input: number;
	    output: number;
	    cacheWrite: number;
	    cacheRead: number;
	    total: number;
	    messages: number;
	
	    static createFrom(source: any = {}) {
	        return new Totals(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.input = source["input"];
	        this.output = source["output"];
	        this.cacheWrite = source["cacheWrite"];
	        this.cacheRead = source["cacheRead"];
	        this.total = source["total"];
	        this.messages = source["messages"];
	    }
	}
	export class AgentUsage {
	    agent: string;
	    available: boolean;
	    note: string;
	    source: string;
	    all: Totals;
	    repo: Totals;
	    firstDay: string;
	    lastDay: string;
	    byModel: Bucket[];
	    byDay: Bucket[];
	    cacheHitPercent: number;
	    activity?: Activity;
	
	    static createFrom(source: any = {}) {
	        return new AgentUsage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.agent = source["agent"];
	        this.available = source["available"];
	        this.note = source["note"];
	        this.source = source["source"];
	        this.all = this.convertValues(source["all"], Totals);
	        this.repo = this.convertValues(source["repo"], Totals);
	        this.firstDay = source["firstDay"];
	        this.lastDay = source["lastDay"];
	        this.byModel = this.convertValues(source["byModel"], Bucket);
	        this.byDay = this.convertValues(source["byDay"], Bucket);
	        this.cacheHitPercent = source["cacheHitPercent"];
	        this.activity = this.convertValues(source["activity"], Activity);
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
	
	
	export class Usage {
	    agents: AgentUsage[];
	    days: number;
	
	    static createFrom(source: any = {}) {
	        return new Usage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.agents = this.convertValues(source["agents"], AgentUsage);
	        this.days = source["days"];
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
	export class MongoCollectionInfo {
	    name: string;
	    type: string;
	    estimatedCount: number;
	
	    static createFrom(source: any = {}) {
	        return new MongoCollectionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.estimatedCount = source["estimatedCount"];
	    }
	}
	export class MongoDatabaseInfo {
	    name: string;
	    sizeOnDisk: number;
	    empty: boolean;
	
	    static createFrom(source: any = {}) {
	        return new MongoDatabaseInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.sizeOnDisk = source["sizeOnDisk"];
	        this.empty = source["empty"];
	    }
	}
	export class MongoFieldInfo {
	    path: string;
	    types: string[];
	    count: number;
	    frequency: number;
	
	    static createFrom(source: any = {}) {
	        return new MongoFieldInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.types = source["types"];
	        this.count = source["count"];
	        this.frequency = source["frequency"];
	    }
	}
	export class MongoIndex {
	    name: string;
	    keysJson: string;
	    unique: boolean;
	    sparse: boolean;
	
	    static createFrom(source: any = {}) {
	        return new MongoIndex(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.keysJson = source["keysJson"];
	        this.unique = source["unique"];
	        this.sparse = source["sparse"];
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
	export class RedisPrefixNode {
	    prefix: string;
	    segment: string;
	    keys: number;
	    bytes?: number;
	    children?: RedisPrefixNode[];
	
	    static createFrom(source: any = {}) {
	        return new RedisPrefixNode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.prefix = source["prefix"];
	        this.segment = source["segment"];
	        this.keys = source["keys"];
	        this.bytes = source["bytes"];
	        this.children = this.convertValues(source["children"], RedisPrefixNode);
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
	export class RedisPrefixReport {
	    roots: RedisPrefixNode[];
	    sampled: number;
	    totalKeys: number;
	    truncated?: boolean;
	    memorySampled?: boolean;
	    separator: string;
	
	    static createFrom(source: any = {}) {
	        return new RedisPrefixReport(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.roots = this.convertValues(source["roots"], RedisPrefixNode);
	        this.sampled = source["sampled"];
	        this.totalKeys = source["totalKeys"];
	        this.truncated = source["truncated"];
	        this.memorySampled = source["memorySampled"];
	        this.separator = source["separator"];
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
	export class RedisServerInfo {
	    version: string;
	    mode: string;
	    role: string;
	    uptimeSeconds: number;
	    usedMemoryBytes: number;
	    peakMemoryBytes: number;
	    maxMemoryBytes: number;
	    maxMemoryPolicy?: string;
	    fragmentationRatio?: number;
	    connectedClients: number;
	    blockedClients: number;
	    maxClients?: number;
	    keyspaceHits: number;
	    keyspaceMisses: number;
	    hitRatePct: number;
	    opsPerSecond: number;
	    totalCommandsProcessed: number;
	    totalConnections: number;
	    expiredKeys: number;
	    evictedKeys: number;
	    rejectedConnections: number;
	    usedCpuSys?: number;
	    usedCpuUser?: number;
	    nodes: number;
	
	    static createFrom(source: any = {}) {
	        return new RedisServerInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.mode = source["mode"];
	        this.role = source["role"];
	        this.uptimeSeconds = source["uptimeSeconds"];
	        this.usedMemoryBytes = source["usedMemoryBytes"];
	        this.peakMemoryBytes = source["peakMemoryBytes"];
	        this.maxMemoryBytes = source["maxMemoryBytes"];
	        this.maxMemoryPolicy = source["maxMemoryPolicy"];
	        this.fragmentationRatio = source["fragmentationRatio"];
	        this.connectedClients = source["connectedClients"];
	        this.blockedClients = source["blockedClients"];
	        this.maxClients = source["maxClients"];
	        this.keyspaceHits = source["keyspaceHits"];
	        this.keyspaceMisses = source["keyspaceMisses"];
	        this.hitRatePct = source["hitRatePct"];
	        this.opsPerSecond = source["opsPerSecond"];
	        this.totalCommandsProcessed = source["totalCommandsProcessed"];
	        this.totalConnections = source["totalConnections"];
	        this.expiredKeys = source["expiredKeys"];
	        this.evictedKeys = source["evictedKeys"];
	        this.rejectedConnections = source["rejectedConnections"];
	        this.usedCpuSys = source["usedCpuSys"];
	        this.usedCpuUser = source["usedCpuUser"];
	        this.nodes = source["nodes"];
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
	
	export class BufferStats {
	    hit: number;
	    read: number;
	    dirtied?: number;
	    written?: number;
	    hitRatePct: number;
	
	    static createFrom(source: any = {}) {
	        return new BufferStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hit = source["hit"];
	        this.read = source["read"];
	        this.dirtied = source["dirtied"];
	        this.written = source["written"];
	        this.hitRatePct = source["hitRatePct"];
	    }
	}
	export class Insight {
	    kind: string;
	    severity: string;
	    title: string;
	    detail: string;
	    node?: string;
	    sql?: string;
	
	    static createFrom(source: any = {}) {
	        return new Insight(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.severity = source["severity"];
	        this.title = source["title"];
	        this.detail = source["detail"];
	        this.node = source["node"];
	        this.sql = source["sql"];
	    }
	}
	export class PlanNode {
	    operation: string;
	    objectName?: string;
	    cost?: number;
	    rows?: number;
	    actualRows?: number;
	    loops?: number;
	    actualTimeMs?: number;
	    isFullScan?: boolean;
	    indexName?: string;
	    filter?: string;
	    detail?: string;
	    selfTimeMs?: number;
	    selfCost?: number;
	    impactPct?: number;
	    rowsRatio?: number;
	    severity?: string;
	    isBottleneck?: boolean;
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
	        this.actualRows = source["actualRows"];
	        this.loops = source["loops"];
	        this.actualTimeMs = source["actualTimeMs"];
	        this.isFullScan = source["isFullScan"];
	        this.indexName = source["indexName"];
	        this.filter = source["filter"];
	        this.detail = source["detail"];
	        this.selfTimeMs = source["selfTimeMs"];
	        this.selfCost = source["selfCost"];
	        this.impactPct = source["impactPct"];
	        this.rowsRatio = source["rowsRatio"];
	        this.severity = source["severity"];
	        this.isBottleneck = source["isBottleneck"];
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
	    engine?: string;
	    analyzed?: boolean;
	    rolledBack?: boolean;
	    planningTimeMs?: number;
	    executionTimeMs?: number;
	    totalCost?: number;
	    estimatedRows?: number;
	    actualRows?: number;
	    nodeCount?: number;
	    buffers?: BufferStats;
	    insights?: Insight[];
	
	    static createFrom(source: any = {}) {
	        return new Plan(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = this.convertValues(source["root"], PlanNode);
	        this.rawText = source["rawText"];
	        this.durationMs = source["durationMs"];
	        this.engine = source["engine"];
	        this.analyzed = source["analyzed"];
	        this.rolledBack = source["rolledBack"];
	        this.planningTimeMs = source["planningTimeMs"];
	        this.executionTimeMs = source["executionTimeMs"];
	        this.totalCost = source["totalCost"];
	        this.estimatedRows = source["estimatedRows"];
	        this.actualRows = source["actualRows"];
	        this.nodeCount = source["nodeCount"];
	        this.buffers = this.convertValues(source["buffers"], BufferStats);
	        this.insights = this.convertValues(source["insights"], Insight);
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

export namespace git {
	
	export class AuthConfig {
	    mode: string;
	    sshKeyPath: string;
	    sshKeyPassphrase: string;
	    username: string;
	    token: string;
	
	    static createFrom(source: any = {}) {
	        return new AuthConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.mode = source["mode"];
	        this.sshKeyPath = source["sshKeyPath"];
	        this.sshKeyPassphrase = source["sshKeyPassphrase"];
	        this.username = source["username"];
	        this.token = source["token"];
	    }
	}
	export class Availability {
	    available: boolean;
	    version: string;
	    path: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new Availability(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.available = source["available"];
	        this.version = source["version"];
	        this.path = source["path"];
	        this.error = source["error"];
	    }
	}
	export class BlameLine {
	    line: number;
	    hash: string;
	    shortHash: string;
	    author: string;
	    email: string;
	    date: string;
	    summary: string;
	    uncommitted: boolean;
	
	    static createFrom(source: any = {}) {
	        return new BlameLine(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.line = source["line"];
	        this.hash = source["hash"];
	        this.shortHash = source["shortHash"];
	        this.author = source["author"];
	        this.email = source["email"];
	        this.date = source["date"];
	        this.summary = source["summary"];
	        this.uncommitted = source["uncommitted"];
	    }
	}
	export class Branch {
	    name: string;
	    hash: string;
	    upstream: string;
	    ahead: number;
	    behind: number;
	    isCurrent: boolean;
	    isRemote: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Branch(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.hash = source["hash"];
	        this.upstream = source["upstream"];
	        this.ahead = source["ahead"];
	        this.behind = source["behind"];
	        this.isCurrent = source["isCurrent"];
	        this.isRemote = source["isRemote"];
	    }
	}
	export class CommandEntry {
	    command: string;
	    dir: string;
	    atMs: number;
	    durationMs: number;
	    failed: boolean;
	    output?: string;
	
	    static createFrom(source: any = {}) {
	        return new CommandEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.command = source["command"];
	        this.dir = source["dir"];
	        this.atMs = source["atMs"];
	        this.durationMs = source["durationMs"];
	        this.failed = source["failed"];
	        this.output = source["output"];
	    }
	}
	export class DiffStat {
	    filesChanged: number;
	    insertions: number;
	    deletions: number;
	
	    static createFrom(source: any = {}) {
	        return new DiffStat(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.filesChanged = source["filesChanged"];
	        this.insertions = source["insertions"];
	        this.deletions = source["deletions"];
	    }
	}
	export class CommitInfo {
	    hash: string;
	    shortHash: string;
	    author: string;
	    email: string;
	    date: string;
	    subject: string;
	    body: string;
	    parents: string[];
	    branches: string[];
	    tags: string[];
	    isHead: boolean;
	    stats: DiffStat;
	
	    static createFrom(source: any = {}) {
	        return new CommitInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hash = source["hash"];
	        this.shortHash = source["shortHash"];
	        this.author = source["author"];
	        this.email = source["email"];
	        this.date = source["date"];
	        this.subject = source["subject"];
	        this.body = source["body"];
	        this.parents = source["parents"];
	        this.branches = source["branches"];
	        this.tags = source["tags"];
	        this.isHead = source["isHead"];
	        this.stats = this.convertValues(source["stats"], DiffStat);
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
	
	export class DiffTarget {
	    mode: string;
	    commit: string;
	    path: string;
	    contextLines: number;
	    ignoreWhitespace: boolean;
	
	    static createFrom(source: any = {}) {
	        return new DiffTarget(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.mode = source["mode"];
	        this.commit = source["commit"];
	        this.path = source["path"];
	        this.contextLines = source["contextLines"];
	        this.ignoreWhitespace = source["ignoreWhitespace"];
	    }
	}
	export class FetchOptions {
	    remote: string;
	    all: boolean;
	    tags: boolean;
	    prune: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FetchOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.remote = source["remote"];
	        this.all = source["all"];
	        this.tags = source["tags"];
	        this.prune = source["prune"];
	    }
	}
	export class FileDiff {
	    path: string;
	    origPath: string;
	    patch: string;
	    isBinary: boolean;
	    stat: DiffStat;
	
	    static createFrom(source: any = {}) {
	        return new FileDiff(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.origPath = source["origPath"];
	        this.patch = source["patch"];
	        this.isBinary = source["isBinary"];
	        this.stat = this.convertValues(source["stat"], DiffStat);
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
	export class FileStatus {
	    path: string;
	    origPath: string;
	    indexStatus: string;
	    workStatus: string;
	    staged: boolean;
	    untracked: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FileStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.origPath = source["origPath"];
	        this.indexStatus = source["indexStatus"];
	        this.workStatus = source["workStatus"];
	        this.staged = source["staged"];
	        this.untracked = source["untracked"];
	    }
	}
	export class ForgeInfo {
	    provider: string;
	    webUrl: string;
	    compareUrl: string;
	
	    static createFrom(source: any = {}) {
	        return new ForgeInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.provider = source["provider"];
	        this.webUrl = source["webUrl"];
	        this.compareUrl = source["compareUrl"];
	    }
	}
	export class Identity {
	    localName: string;
	    localEmail: string;
	    globalName: string;
	    globalEmail: string;
	    effectiveName: string;
	    effectiveEmail: string;
	    usingGlobal: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Identity(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.localName = source["localName"];
	        this.localEmail = source["localEmail"];
	        this.globalName = source["globalName"];
	        this.globalEmail = source["globalEmail"];
	        this.effectiveName = source["effectiveName"];
	        this.effectiveEmail = source["effectiveEmail"];
	        this.usingGlobal = source["usingGlobal"];
	    }
	}
	export class LogOptions {
	    maxCount: number;
	    skip: number;
	    rev: string;
	    revs: string[];
	    all: boolean;
	    path: string;
	    withStats: boolean;
	    author: string;
	    grep: string;
	    since: string;
	    until: string;
	
	    static createFrom(source: any = {}) {
	        return new LogOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.maxCount = source["maxCount"];
	        this.skip = source["skip"];
	        this.rev = source["rev"];
	        this.revs = source["revs"];
	        this.all = source["all"];
	        this.path = source["path"];
	        this.withStats = source["withStats"];
	        this.author = source["author"];
	        this.grep = source["grep"];
	        this.since = source["since"];
	        this.until = source["until"];
	    }
	}
	export class PullOptions {
	    remote: string;
	    branch: string;
	    ffOnly: boolean;
	    rebase: boolean;
	    autostash: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PullOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.remote = source["remote"];
	        this.branch = source["branch"];
	        this.ffOnly = source["ffOnly"];
	        this.rebase = source["rebase"];
	        this.autostash = source["autostash"];
	    }
	}
	export class PushOptions {
	    remote: string;
	    branch: string;
	    force: boolean;
	    forceWithLease: boolean;
	    noVerify: boolean;
	    setUpstream: boolean;
	    tags: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PushOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.remote = source["remote"];
	        this.branch = source["branch"];
	        this.force = source["force"];
	        this.forceWithLease = source["forceWithLease"];
	        this.noVerify = source["noVerify"];
	        this.setUpstream = source["setUpstream"];
	        this.tags = source["tags"];
	    }
	}
	export class RebaseAction {
	    command: string;
	    hash: string;
	    subject: string;
	    message?: string;
	
	    static createFrom(source: any = {}) {
	        return new RebaseAction(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.command = source["command"];
	        this.hash = source["hash"];
	        this.subject = source["subject"];
	        this.message = source["message"];
	    }
	}
	export class Remote {
	    name: string;
	    fetchUrl: string;
	    pushUrl: string;
	
	    static createFrom(source: any = {}) {
	        return new Remote(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.fetchUrl = source["fetchUrl"];
	        this.pushUrl = source["pushUrl"];
	    }
	}
	export class RepoStatus {
	    branch: string;
	    upstream: string;
	    ahead: number;
	    behind: number;
	    detached: boolean;
	    files: FileStatus[];
	    hasChanges: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RepoStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.branch = source["branch"];
	        this.upstream = source["upstream"];
	        this.ahead = source["ahead"];
	        this.behind = source["behind"];
	        this.detached = source["detached"];
	        this.files = this.convertValues(source["files"], FileStatus);
	        this.hasChanges = source["hasChanges"];
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
	export class Stash {
	    ref: string;
	    index: number;
	    branch: string;
	    message: string;
	    date: string;
	
	    static createFrom(source: any = {}) {
	        return new Stash(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ref = source["ref"];
	        this.index = source["index"];
	        this.branch = source["branch"];
	        this.message = source["message"];
	        this.date = source["date"];
	    }
	}
	export class Tag {
	    name: string;
	    hash: string;
	    annotated: boolean;
	    message: string;
	    taggerDate: string;
	
	    static createFrom(source: any = {}) {
	        return new Tag(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.hash = source["hash"];
	        this.annotated = source["annotated"];
	        this.message = source["message"];
	        this.taggerDate = source["taggerDate"];
	    }
	}
	export class WorkFile {
	    path: string;
	    content: string;
	    size: number;
	    modTimeUnix: number;
	    binary: boolean;
	    tooLarge: boolean;
	
	    static createFrom(source: any = {}) {
	        return new WorkFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.size = source["size"];
	        this.modTimeUnix = source["modTimeUnix"];
	        this.binary = source["binary"];
	        this.tooLarge = source["tooLarge"];
	    }
	}
	export class WorkTree {
	    files: string[];
	    truncated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new WorkTree(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.files = source["files"];
	        this.truncated = source["truncated"];
	    }
	}
	export class Worktree {
	    path: string;
	    branch: string;
	    head: string;
	    isMain: boolean;
	    detached: boolean;
	    locked: boolean;
	    prunable: boolean;
	    reason?: string;
	
	    static createFrom(source: any = {}) {
	        return new Worktree(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.branch = source["branch"];
	        this.head = source["head"];
	        this.isMain = source["isMain"];
	        this.detached = source["detached"];
	        this.locked = source["locked"];
	        this.prunable = source["prunable"];
	        this.reason = source["reason"];
	    }
	}

}

export namespace localterm {
	
	export class Shell {
	    id: string;
	    label: string;
	    path: string;
	    args: string[];
	    available: boolean;
	    note: string;
	
	    static createFrom(source: any = {}) {
	        return new Shell(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.path = source["path"];
	        this.args = source["args"];
	        this.available = source["available"];
	        this.note = source["note"];
	    }
	}

}

export namespace main {
	
	export class ConnectionEditInfo {
	    name: string;
	    dbType: string;
	    params: Record<string, string>;
	    color: string;
	    environment: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionEditInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.dbType = source["dbType"];
	        this.params = source["params"];
	        this.color = source["color"];
	        this.environment = source["environment"];
	    }
	}
	export class ConnectionInput {
	    name: string;
	    dbType: string;
	    params: Record<string, string>;
	    color: string;
	    environment: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.dbType = source["dbType"];
	        this.params = source["params"];
	        this.color = source["color"];
	        this.environment = source["environment"];
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
	    onConflict: string;
	
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
	        this.onConflict = source["onConflict"];
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

export namespace mcpconf {
	
	export class File {
	    path: string;
	    agent: string;
	    scope: string;
	    present: boolean;
	    error: string;
	    servers: number;
	    writable: boolean;
	
	    static createFrom(source: any = {}) {
	        return new File(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.agent = source["agent"];
	        this.scope = source["scope"];
	        this.present = source["present"];
	        this.error = source["error"];
	        this.servers = source["servers"];
	        this.writable = source["writable"];
	    }
	}
	export class Server {
	    name: string;
	    agent: string;
	    scope: string;
	    transport: string;
	    command: string;
	    args: string[];
	    url: string;
	    envKeys: string[];
	    source: string;
	
	    static createFrom(source: any = {}) {
	        return new Server(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.agent = source["agent"];
	        this.scope = source["scope"];
	        this.transport = source["transport"];
	        this.command = source["command"];
	        this.args = source["args"];
	        this.url = source["url"];
	        this.envKeys = source["envKeys"];
	        this.source = source["source"];
	    }
	}
	export class Config {
	    servers: Server[];
	    files: File[];
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.servers = this.convertValues(source["servers"], Server);
	        this.files = this.convertValues(source["files"], File);
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
	
	
	export class ServerInput {
	    name: string;
	    transport: string;
	    command: string;
	    args: string[];
	    url: string;
	    env: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new ServerInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.transport = source["transport"];
	        this.command = source["command"];
	        this.args = source["args"];
	        this.url = source["url"];
	        this.env = source["env"];
	    }
	}

}

export namespace redisquery {
	
	export class LuaResult {
	    sha?: string;
	    kind?: string;
	    value?: any;
	    durationMs?: number;
	
	    static createFrom(source: any = {}) {
	        return new LuaResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sha = source["sha"];
	        this.kind = source["kind"];
	        this.value = source["value"];
	        this.durationMs = source["durationMs"];
	    }
	}

}

export namespace sftpx {
	
	export class Conflict {
	    name: string;
	    srcSize: number;
	    dstSize: number;
	    srcModTime: number;
	    dstModTime: number;
	    isDir: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Conflict(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.srcSize = source["srcSize"];
	        this.dstSize = source["dstSize"];
	        this.srcModTime = source["srcModTime"];
	        this.dstModTime = source["dstModTime"];
	        this.isDir = source["isDir"];
	    }
	}
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
	export class RemoteFile {
	    path: string;
	    content: string;
	    size: number;
	    modTimeUnix: number;
	    binary: boolean;
	    tooLarge: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RemoteFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	        this.size = source["size"];
	        this.modTimeUnix = source["modTimeUnix"];
	        this.binary = source["binary"];
	        this.tooLarge = source["tooLarge"];
	    }
	}

}

export namespace sqlintel {
	
	export class Item {
	    l: string;
	    k: string;
	    d?: string;
	    a?: string;
	    i?: string;
	    s: number;
	
	    static createFrom(source: any = {}) {
	        return new Item(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.l = source["l"];
	        this.k = source["k"];
	        this.d = source["d"];
	        this.a = source["a"];
	        this.i = source["i"];
	        this.s = source["s"];
	    }
	}
	export class JoinCondition {
	    condition: string;
	    left: string;
	    right: string;
	    viaPrimaryKey?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new JoinCondition(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.condition = source["condition"];
	        this.left = source["left"];
	        this.right = source["right"];
	        this.viaPrimaryKey = source["viaPrimaryKey"];
	    }
	}
	export class Request {
	    connId: string;
	    dbType: string;
	    sql: string;
	    offset: number;
	    explicit: boolean;
	    limit: number;
	
	    static createFrom(source: any = {}) {
	        return new Request(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connId = source["connId"];
	        this.dbType = source["dbType"];
	        this.sql = source["sql"];
	        this.offset = source["offset"];
	        this.explicit = source["explicit"];
	        this.limit = source["limit"];
	    }
	}
	export class Response {
	    from: number;
	    items: Item[];
	    inline?: string;
	    clause?: string;
	    truncated?: boolean;
	    indexing?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Response(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.from = source["from"];
	        this.items = this.convertValues(source["items"], Item);
	        this.inline = source["inline"];
	        this.clause = source["clause"];
	        this.truncated = source["truncated"];
	        this.indexing = source["indexing"];
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
	export class Status {
	    connId: string;
	    state: string;
	    tables: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new Status(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connId = source["connId"];
	        this.state = source["state"];
	        this.tables = source["tables"];
	        this.error = source["error"];
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
	
	export class AgentChat {
	    id: string;
	    repoId: string;
	    agentId: string;
	    title: string;
	    conversationId: string;
	    createdAt: number;
	    updatedAt: number;
	    model: string;
	    effort: string;
	    mode: string;
	
	    static createFrom(source: any = {}) {
	        return new AgentChat(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.repoId = source["repoId"];
	        this.agentId = source["agentId"];
	        this.title = source["title"];
	        this.conversationId = source["conversationId"];
	        this.createdAt = source["createdAt"];
	        this.updatedAt = source["updatedAt"];
	        this.model = source["model"];
	        this.effort = source["effort"];
	        this.mode = source["mode"];
	    }
	}
	export class ConnectionSummary {
	    id: string;
	    name: string;
	    dbType: string;
	    createdAt: number;
	    metadataSchemas: string[];
	    color?: string;
	    folderId?: string;
	    environment?: string;
	
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
	        this.environment = source["environment"];
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
	export class GitCredential {
	    id: string;
	    host: string;
	    username: string;
	    createdAt: number;
	
	    static createFrom(source: any = {}) {
	        return new GitCredential(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.host = source["host"];
	        this.username = source["username"];
	        this.createdAt = source["createdAt"];
	    }
	}
	export class GitPanelSession {
	    kind: string;
	    agentId?: string;
	    title: string;
	
	    static createFrom(source: any = {}) {
	        return new GitPanelSession(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.kind = source["kind"];
	        this.agentId = source["agentId"];
	        this.title = source["title"];
	    }
	}
	export class GitRepo {
	    id: string;
	    name: string;
	    path: string;
	    folderId?: string;
	    sortOrder: number;
	    createdAt: number;
	    pinnedBranches: string[];
	
	    static createFrom(source: any = {}) {
	        return new GitRepo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.path = source["path"];
	        this.folderId = source["folderId"];
	        this.sortOrder = source["sortOrder"];
	        this.createdAt = source["createdAt"];
	        this.pinnedBranches = source["pinnedBranches"];
	    }
	}
	export class GitRepoWorkspace {
	    openFiles: string[];
	    defaultAgent: string;
	
	    static createFrom(source: any = {}) {
	        return new GitRepoWorkspace(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.openFiles = source["openFiles"];
	        this.defaultAgent = source["defaultAgent"];
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
	export class SSHKeySummary {
	    id: string;
	    name: string;
	    keyType: string;
	    fingerprint: string;
	    hasPassphrase: boolean;
	    createdAt: number;
	
	    static createFrom(source: any = {}) {
	        return new SSHKeySummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.keyType = source["keyType"];
	        this.fingerprint = source["fingerprint"];
	        this.hasPassphrase = source["hasPassphrase"];
	        this.createdAt = source["createdAt"];
	    }
	}
	export class Settings {
	    theme: string;
	    openTabs: OpenTabInfo[];
	    sidebarCollapsed: boolean;
	    editorHeight: number;
	    gitSideWidth: number;
	    gitDiffWidth: number;
	    gitDiffContext: number;
	    gitDiffIgnoreWs: boolean;
	    gitDiffWrap: boolean;
	    queryPageSize: number;
	    rememberMasterKey: boolean;
	    editorTheme: string;
	    collapsedSidebarModules: string[];
	    sshTerminalTheme: string;
	    localShell: string;
	    gitTermDock: string;
	    gitTermSize: number;
	    gitPanelTab: string;
	    gitPanelSessions: GitPanelSession[];
	    gitSideHidden: boolean;
	    gitDiffHidden: boolean;
	    terminalFontSize: number;
	    autoBackupEnabled: boolean;
	    autoBackupIntervalHours: number;
	    autoBackupPath: string;
	    autoSaveEnabled: boolean;
	    autoSaveIntervalSeconds: number;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.theme = source["theme"];
	        this.openTabs = this.convertValues(source["openTabs"], OpenTabInfo);
	        this.sidebarCollapsed = source["sidebarCollapsed"];
	        this.editorHeight = source["editorHeight"];
	        this.gitSideWidth = source["gitSideWidth"];
	        this.gitDiffWidth = source["gitDiffWidth"];
	        this.gitDiffContext = source["gitDiffContext"];
	        this.gitDiffIgnoreWs = source["gitDiffIgnoreWs"];
	        this.gitDiffWrap = source["gitDiffWrap"];
	        this.queryPageSize = source["queryPageSize"];
	        this.rememberMasterKey = source["rememberMasterKey"];
	        this.editorTheme = source["editorTheme"];
	        this.collapsedSidebarModules = source["collapsedSidebarModules"];
	        this.sshTerminalTheme = source["sshTerminalTheme"];
	        this.localShell = source["localShell"];
	        this.gitTermDock = source["gitTermDock"];
	        this.gitTermSize = source["gitTermSize"];
	        this.gitPanelTab = source["gitPanelTab"];
	        this.gitPanelSessions = this.convertValues(source["gitPanelSessions"], GitPanelSession);
	        this.gitSideHidden = source["gitSideHidden"];
	        this.gitDiffHidden = source["gitDiffHidden"];
	        this.terminalFontSize = source["terminalFontSize"];
	        this.autoBackupEnabled = source["autoBackupEnabled"];
	        this.autoBackupIntervalHours = source["autoBackupIntervalHours"];
	        this.autoBackupPath = source["autoBackupPath"];
	        this.autoSaveEnabled = source["autoSaveEnabled"];
	        this.autoSaveIntervalSeconds = source["autoSaveIntervalSeconds"];
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
	export class SshHistoryEntry {
	    id: number;
	    command: string;
	    ranAt: number;
	
	    static createFrom(source: any = {}) {
	        return new SshHistoryEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.command = source["command"];
	        this.ranAt = source["ranAt"];
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

