export namespace main {
	
	export class ConnectionInput {
	    name: string;
	    dbType: string;
	    params: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionInput(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.dbType = source["dbType"];
	        this.params = source["params"];
	    }
	}

}

export namespace vault {
	
	export class ConnectionSummary {
	    id: string;
	    name: string;
	    dbType: string;
	    createdAt: number;
	
	    static createFrom(source: any = {}) {
	        return new ConnectionSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.dbType = source["dbType"];
	        this.createdAt = source["createdAt"];
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

}

