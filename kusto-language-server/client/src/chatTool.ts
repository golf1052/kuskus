import * as vscode from "vscode";
import { Client as KustoClient } from "azure-kusto-data";
import {
  runQuery,
  type ResultColumn,
  type VisualizationInfo,
} from "./queryRunner.js";
import { log, logError } from "./logger.js";
import { KustoQueryContentProvider } from "./queryDocumentProvider.js";
import type { StoredQueryResults } from "./queryResultsStore.js";

export interface IRunKustoQueryParameters {
  query: string;
}

export interface IListDatabasesParameters {
  clusterUri: string;
}

export interface IGetTableSchemaParameters {
  tableName: string;
}

export interface ISearchQueryResultsParameters {
  searchText: string;
}

export interface ISetActiveDatabaseParameters {
  clusterUri: string;
  databaseName: string;
}

export interface ClusterConnectionAccessor {
  getActiveClient(): KustoClient | undefined;
  getClient(clusterUri: string): KustoClient | undefined;
  getConnectedClusterUris(): string[];
  activeDatabaseName: string | undefined;
  activeClusterUri: string | undefined;
}

export interface ResultsDisplayAccessor {
  showResults(
    columns: ResultColumn[],
    rows: Record<string, unknown>[],
    visualization?: VisualizationInfo,
  ): void;
}

export interface ChartCaptureAccessor {
  captureChart(): Promise<string | undefined>;
}

export interface ActiveDatabaseSwitcher {
  getClient(clusterUri: string): KustoClient | undefined;
  getConnectedClusterUris(): string[];
  activeClusterUri: string | undefined;
  activeDatabaseName: string | undefined;
  applyActiveDatabase(clusterUri: string, databaseName: string): Promise<void>;
}

export interface QueryResultsStoreAccessor {
  setResults(
    columns: ResultColumn[],
    rows: Record<string, unknown>[],
    visualization?: VisualizationInfo,
  ): void;
  getResults(): StoredQueryResults | undefined;
}

const MAX_RESULT_ROWS = 500;

/**
 * Heuristic: does this error message look like an authentication/token problem?
 * Used to attach a re-auth hint to LM tool failures so the model (and the user
 * reading the log) can distinguish an expired token from a genuine query error.
 */
function isLikelyAuthError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("token") ||
    m.includes("authentication") ||
    m.includes("unauthorized") ||
    m.includes("401") ||
    m.includes("aadsts") ||
    m.includes("expired") ||
    m.includes("credential") ||
    m.includes("sign in") ||
    m.includes("login")
  );
}

export class RunKustoQueryTool
  implements vscode.LanguageModelTool<IRunKustoQueryParameters>
{
  constructor(
    private readonly connection: ClusterConnectionAccessor,
    private readonly resultsDisplay: ResultsDisplayAccessor,
    private readonly queryDocProvider: KustoQueryContentProvider,
    private readonly resultsStore?: QueryResultsStoreAccessor,
  ) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<IRunKustoQueryParameters>,
    _token: vscode.CancellationToken,
  ) {
    const db = this.connection.activeDatabaseName ?? "unknown";
    const cluster = this.connection.activeClusterUri ?? "unknown";
    return {
      invocationMessage: `Running Kusto query on ${db}`,
      confirmationMessages: {
        title: "Run Kusto Query",
        message: new vscode.MarkdownString(
          `Run this query on **${cluster}** / **${db}**?\n\n\`\`\`kusto\n${options.input.query}\n\`\`\``,
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IRunKustoQueryParameters>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const client = this.connection.getActiveClient();
    const database = this.connection.activeDatabaseName;

    if (!client || !database) {
      logError(
        `[LM Tool] run_query aborted: no active database (activeClusterUri=${
          this.connection.activeClusterUri ?? "none"
        }, activeDatabaseName=${
          this.connection.activeDatabaseName ?? "none"
        }, client=${client ? "resolved" : "undefined"})`,
      );
      throw new Error(
        "No active Kusto database is configured. Ask the user to connect to a cluster and set an active database in the Kusto Explorer panel first.",
      );
    }

    const query = options.input.query;
    log(`[LM Tool] Running query on ${database}: ${query}`);

    // Open a virtual document showing the query in the editor
    const queryUri = this.queryDocProvider.createQueryUri(query);
    const doc = await vscode.workspace.openTextDocument(queryUri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: true,
    });
    await vscode.languages.setTextDocumentLanguage(doc, "kusto");

    const result = await runQuery(client, database, query);

    if (!result.success) {
      logError(`[LM Tool] Query failed: ${result.error}`);
      if (result.fullError) {
        logError(`[LM Tool] Full error details:\n${result.fullError}`);
      }
      const authHint =
        result.error && isLikelyAuthError(result.error)
          ? " This looks like an authentication/token problem — the access token may have expired. Check the [Kuskus] output channel (enable kuskusLanguageServer.verboseLogging for details) and retry; if it persists, sign out and back in from the Kusto Explorer."
          : "";
      if (authHint) {
        logError(
          "[LM Tool] Query failure appears authentication-related; token may have expired",
        );
      }
      throw new Error(`Kusto query failed: ${result.error}.${authHint}`);
    }

    log(`[LM Tool] Query returned ${result.rowCount} row(s)`);

    // Show results in the Results panel
    this.resultsDisplay.showResults(
      result.columns,
      result.rows,
      result.visualization,
    );

    // Store results for downstream tools (e.g. search_query_results)
    this.resultsStore?.setResults(
      result.columns,
      result.rows,
      result.visualization,
    );

    const truncated = result.rowCount > MAX_RESULT_ROWS;
    const rows = truncated
      ? result.rows.slice(0, MAX_RESULT_ROWS)
      : result.rows;

    const payload = {
      columns: result.columns,
      rows,
      rowCount: result.rowCount,
      ...(truncated && {
        truncated: true,
        note: `Results truncated to first ${MAX_RESULT_ROWS} of ${result.rowCount} rows.`,
      }),
    };

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(payload)),
    ]);
  }
}

export class ListDatabasesTool
  implements vscode.LanguageModelTool<IListDatabasesParameters>
{
  constructor(private readonly connection: ClusterConnectionAccessor) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<IListDatabasesParameters>,
    _token: vscode.CancellationToken,
  ) {
    return {
      invocationMessage: `Listing databases on ${options.input.clusterUri}`,
      confirmationMessages: {
        title: "List Kusto Databases",
        message: new vscode.MarkdownString(
          `List all databases on **${options.input.clusterUri}**?`,
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IListDatabasesParameters>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { clusterUri } = options.input;
    const client = this.connection.getClient(clusterUri);

    if (!client) {
      const connected = this.connection.getConnectedClusterUris();
      const list =
        connected.length > 0
          ? `Connected clusters: ${connected.join(", ")}`
          : "No clusters are currently connected.";
      throw new Error(
        `Cluster "${clusterUri}" is not connected. ${list} Ask the user to connect to the cluster first via the Kusto Explorer panel.`,
      );
    }

    log(`[LM Tool] Listing databases on ${clusterUri}`);

    const result = await client.execute("", ".show databases");

    if (result.primaryResults.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify([])),
      ]);
    }

    const table = result.primaryResults[0];
    const databases: { name: string; prettyName: string }[] = [];
    for (const row of table.rows()) {
      databases.push({
        name: row["DatabaseName"] ?? "",
        prettyName: row["PrettyName"] ?? "",
      });
    }

    log(`[LM Tool] Found ${databases.length} database(s) on ${clusterUri}`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(databases)),
    ]);
  }
}

export class ListTablesTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  constructor(private readonly connection: ClusterConnectionAccessor) {}

  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<
      Record<string, never>
    >,
    _token: vscode.CancellationToken,
  ) {
    const db = this.connection.activeDatabaseName ?? "unknown";
    const cluster = this.connection.activeClusterUri ?? "unknown";
    return {
      invocationMessage: `Listing tables in ${db}`,
      confirmationMessages: {
        title: "List Kusto Tables",
        message: new vscode.MarkdownString(
          `List all tables in **${cluster}** / **${db}**?`,
        ),
      },
    };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const client = this.connection.getActiveClient();
    const database = this.connection.activeDatabaseName;

    if (!client || !database) {
      logError(
        `[LM Tool] list_tables aborted: no active database (activeClusterUri=${
          this.connection.activeClusterUri ?? "none"
        }, activeDatabaseName=${
          this.connection.activeDatabaseName ?? "none"
        }, client=${client ? "resolved" : "undefined"})`,
      );
      throw new Error(
        "No active Kusto database is configured. Ask the user to connect to a cluster and set an active database in the Kusto Explorer panel first.",
      );
    }

    log(`[LM Tool] Listing tables in ${database}`);

    const result = await client.execute(database, ".show tables");

    if (result.primaryResults.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify([])),
      ]);
    }

    const table = result.primaryResults[0];
    const tables: string[] = [];
    for (const row of table.rows()) {
      const name = row["TableName"];
      if (name) {
        tables.push(name);
      }
    }

    log(`[LM Tool] Found ${tables.length} table(s) in ${database}`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(tables)),
    ]);
  }
}

export class GetTableSchemaTool
  implements vscode.LanguageModelTool<IGetTableSchemaParameters>
{
  constructor(private readonly connection: ClusterConnectionAccessor) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<IGetTableSchemaParameters>,
    _token: vscode.CancellationToken,
  ) {
    const db = this.connection.activeDatabaseName ?? "unknown";
    const cluster = this.connection.activeClusterUri ?? "unknown";
    return {
      invocationMessage: `Getting schema for ${options.input.tableName}`,
      confirmationMessages: {
        title: "Get Table Schema",
        message: new vscode.MarkdownString(
          `Get the schema of table **${options.input.tableName}** in **${cluster}** / **${db}**?`,
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IGetTableSchemaParameters>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const client = this.connection.getActiveClient();
    const database = this.connection.activeDatabaseName;

    if (!client || !database) {
      logError(
        `[LM Tool] get_table_schema aborted: no active database (activeClusterUri=${
          this.connection.activeClusterUri ?? "none"
        }, activeDatabaseName=${
          this.connection.activeDatabaseName ?? "none"
        }, client=${client ? "resolved" : "undefined"})`,
      );
      throw new Error(
        "No active Kusto database is configured. Ask the user to connect to a cluster and set an active database in the Kusto Explorer panel first.",
      );
    }

    const { tableName } = options.input;
    log(`[LM Tool] Getting schema for table ${tableName} in ${database}`);

    const result = await client.execute(database, `.show table ${tableName}`);

    if (result.primaryResults.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify([])),
      ]);
    }

    const table = result.primaryResults[0];
    const columns: { name: string; type: string }[] = [];
    for (const row of table.rows()) {
      columns.push({
        name: row["AttributeName"] ?? "",
        type: row["AttributeType"] ?? "",
      });
    }

    log(`[LM Tool] Table ${tableName} has ${columns.length} column(s)`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(columns)),
    ]);
  }
}

export class SearchQueryResultsTool
  implements vscode.LanguageModelTool<ISearchQueryResultsParameters>
{
  constructor(private readonly resultsStore: QueryResultsStoreAccessor) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ISearchQueryResultsParameters>,
    _token: vscode.CancellationToken,
  ) {
    return {
      invocationMessage: `Searching query results for "${options.input.searchText}"`,
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ISearchQueryResultsParameters>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const stored = this.resultsStore.getResults();
    if (!stored) {
      throw new Error(
        "No query results are available to search. Ask the user to run a Kusto query first using the run_kusto_query tool or by pressing Shift+Enter in a .kusto file.",
      );
    }

    const searchText = options.input.searchText.toLowerCase();
    log(
      `[LM Tool] Searching ${stored.rows.length} row(s) for "${options.input.searchText}"`,
    );

    const matchedRows = stored.rows.filter((row) =>
      stored.columns.some((col) => {
        const val = row[col.name];
        return val != null && String(val).toLowerCase().includes(searchText);
      }),
    );

    const truncated = matchedRows.length > MAX_RESULT_ROWS;
    const rows = truncated
      ? matchedRows.slice(0, MAX_RESULT_ROWS)
      : matchedRows;

    log(`[LM Tool] Search matched ${matchedRows.length} row(s)`);

    const payload = {
      columns: stored.columns,
      rows,
      matchCount: matchedRows.length,
      totalRows: stored.rows.length,
      searchText: options.input.searchText,
      ...(truncated && {
        truncated: true,
        note: `Results truncated to first ${MAX_RESULT_ROWS} of ${matchedRows.length} matching rows.`,
      }),
    };

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(payload)),
    ]);
  }
}

export class ListClustersTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  constructor(private readonly connection: ClusterConnectionAccessor) {}

  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<
      Record<string, never>
    >,
    _token: vscode.CancellationToken,
  ) {
    return {
      invocationMessage: "Listing connected Kusto clusters",
      confirmationMessages: {
        title: "List Connected Clusters",
        message: new vscode.MarkdownString(
          "List all clusters currently connected in the Kusto Explorer?",
        ),
      },
    };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const clusterUris = this.connection.getConnectedClusterUris();
    log(`[LM Tool] Listing ${clusterUris.length} connected cluster(s)`);

    const clusters = clusterUris.map((uri) => ({
      clusterUri: uri,
      isActive: uri === this.connection.activeClusterUri,
      activeDatabaseName:
        uri === this.connection.activeClusterUri
          ? this.connection.activeDatabaseName
          : undefined,
    }));

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(clusters)),
    ]);
  }
}

export class GetChartImageTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  constructor(
    private readonly chartCapture: ChartCaptureAccessor,
    private readonly resultsStore: QueryResultsStoreAccessor,
  ) {}

  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<
      Record<string, never>
    >,
    _token: vscode.CancellationToken,
  ) {
    return {
      invocationMessage: "Capturing chart visualization",
    };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const stored = this.resultsStore.getResults();
    if (!stored) {
      throw new Error(
        "No query results are available. Ask the user to run a Kusto query first.",
      );
    }

    const vizType = stored.visualization?.visualization;
    if (!vizType || vizType === "table") {
      throw new Error(
        "No chart visualization is currently displayed. The results are shown as a table. Ask the user to run a query with a render operator (e.g. '| render linechart').",
      );
    }

    log(`[LM Tool] Capturing chart image for visualization: ${vizType}`);
    const dataUrl = await this.chartCapture.captureChart();

    if (!dataUrl) {
      throw new Error(
        "Failed to capture the chart image. The chart may not be visible in the Results panel.",
      );
    }

    const payload = {
      visualization: vizType,
      title: stored.visualization?.title || undefined,
      columns: stored.columns.map((c) => c.name),
      rowCount: stored.rows.length,
      imageDataUrl: dataUrl,
    };

    log(`[LM Tool] Chart image captured (${dataUrl.length} chars)`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(payload)),
    ]);
  }
}

export class SetActiveDatabaseTool
  implements vscode.LanguageModelTool<ISetActiveDatabaseParameters>
{
  constructor(private readonly connection: ActiveDatabaseSwitcher) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ISetActiveDatabaseParameters>,
    _token: vscode.CancellationToken,
  ) {
    const { clusterUri, databaseName } = options.input;
    return {
      invocationMessage: `Switching active database to ${databaseName}`,
      confirmationMessages: {
        title: "Set Active Kusto Database",
        message: new vscode.MarkdownString(
          `Set the active database to **${clusterUri}** / **${databaseName}**? Subsequent queries and schema lookups will run against this database.`,
        ),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ISetActiveDatabaseParameters>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { clusterUri, databaseName } = options.input;
    const client = this.connection.getClient(clusterUri);

    if (!client) {
      const connected = this.connection.getConnectedClusterUris();
      const list =
        connected.length > 0
          ? `Connected clusters: ${connected.join(", ")}`
          : "No clusters are currently connected.";
      throw new Error(
        `Cluster "${clusterUri}" is not connected. ${list} Ask the user to connect to the cluster first via the Kusto Explorer panel, or use the list_clusters tool to see what is available.`,
      );
    }

    log(`[LM Tool] Setting active database to ${clusterUri}/${databaseName}`);

    // Validate the database exists and resolve its canonical name.
    const result = await client.execute("", ".show databases");
    const available: string[] = [];
    if (result.primaryResults.length > 0) {
      for (const row of result.primaryResults[0].rows()) {
        const name = row["DatabaseName"];
        if (name) {
          available.push(name);
        }
      }
    }

    const canonical = available.find(
      (name) => name.toLowerCase() === databaseName.toLowerCase(),
    );

    if (!canonical) {
      const list =
        available.length > 0
          ? `Available databases: ${available.join(", ")}`
          : "No databases were found on this cluster.";
      throw new Error(
        `Database "${databaseName}" was not found on cluster "${clusterUri}". ${list} Use the list_databases tool to see valid database names.`,
      );
    }

    await this.connection.applyActiveDatabase(clusterUri, canonical);

    log(`[LM Tool] Active database is now ${clusterUri}/${canonical}`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        JSON.stringify({
          success: true,
          clusterUri,
          databaseName: canonical,
        }),
      ),
    ]);
  }
}

export class GetActiveDatabaseTool
  implements vscode.LanguageModelTool<Record<string, never>>
{
  constructor(private readonly connection: ActiveDatabaseSwitcher) {}

  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<
      Record<string, never>
    >,
    _token: vscode.CancellationToken,
  ) {
    return {
      invocationMessage: "Getting the active Kusto database",
    };
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const clusterUri = this.connection.activeClusterUri;
    const databaseName = this.connection.activeDatabaseName;

    const payload =
      clusterUri && databaseName
        ? { active: true, clusterUri, databaseName }
        : { active: false };

    log(
      `[LM Tool] Active database: ${
        payload.active ? `${clusterUri}/${databaseName}` : "none"
      }`,
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(JSON.stringify(payload)),
    ]);
  }
}
