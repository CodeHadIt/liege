import { rateLimit } from "@/lib/rate-limiter";

export interface EtherscanConfig {
  apiUrl: string;
  apiKey: string;
  rateLimiterKey: string;
}

export interface EtherscanTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  gas: string;
  gasUsed: string;
  gasPrice: string;
  functionName: string;
  isError: string;
}

export interface EtherscanTokenTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
  contractAddress: string;
}

export interface EtherscanTokenBalance {
  TokenAddress: string;
  TokenName: string;
  TokenSymbol: string;
  TokenDecimal: string;
  TokenQuantity: string;
}

export interface EtherscanSourceCode {
  SourceCode: string;
  ABI: string;
  ContractName: string;
  CompilerVersion: string;
  OptimizationUsed: string;
  Runs: string;
  ConstructorArguments: string;
  EVMVersion: string;
  Library: string;
  LicenseType: string;
  Proxy: string;
  Implementation: string;
  SwarmSource: string;
}

async function fetchEtherscan<T>(
  config: EtherscanConfig,
  params: Record<string, string>
): Promise<T | null> {
  await rateLimit(config.rateLimiterKey);
  try {
    const searchParams = new URLSearchParams({
      ...params,
      apikey: config.apiKey,
    });
    const res = await fetch(`${config.apiUrl}?${searchParams}`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.status === "0" && json.message === "NOTOK") return null;
    return json.result;
  } catch {
    return null;
  }
}

export function createEtherscanClient(config: EtherscanConfig) {
  return {
    async getContractSourceCode(address: string): Promise<EtherscanSourceCode[] | null> {
      return fetchEtherscan<EtherscanSourceCode[]>(config, {
        module: "contract",
        action: "getsourcecode",
        address,
      });
    },

    async getTokenBalances(address: string): Promise<EtherscanTokenBalance[] | null> {
      return fetchEtherscan<EtherscanTokenBalance[]>(config, {
        module: "account",
        action: "addresstokenbalance",
        address,
        page: "1",
        offset: "50",
      });
    },

    async getNormalTxList(address: string, limit = 50): Promise<EtherscanTx[] | null> {
      return fetchEtherscan<EtherscanTx[]>(config, {
        module: "account",
        action: "txlist",
        address,
        startblock: "0",
        endblock: "99999999",
        page: "1",
        offset: limit.toString(),
        sort: "desc",
      });
    },

    async getTokenTxList(address: string, limit = 50): Promise<EtherscanTokenTx[] | null> {
      return fetchEtherscan<EtherscanTokenTx[]>(config, {
        module: "account",
        action: "tokentx",
        address,
        startblock: "0",
        endblock: "99999999",
        page: "1",
        offset: limit.toString(),
        sort: "desc",
      });
    },

    async getTokenTxListForContract(
      address: string,
      contractAddress: string,
      limit = 100
    ): Promise<EtherscanTokenTx[] | null> {
      return fetchEtherscan<EtherscanTokenTx[]>(config, {
        module: "account",
        action: "tokentx",
        address,
        contractaddress: contractAddress,
        startblock: "0",
        endblock: "99999999",
        page: "1",
        offset: limit.toString(),
        sort: "desc",
      });
    },

    async getBalance(address: string): Promise<string | null> {
      return fetchEtherscan<string>(config, {
        module: "account",
        action: "balance",
        address,
        tag: "latest",
      });
    },
  };
}

// Pre-configured clients
export const basescanClient = createEtherscanClient({
  apiUrl: "https://api.basescan.org/api",
  apiKey: process.env.BASESCAN_API_KEY || "",
  rateLimiterKey: "basescan",
});

export const bscscanClient = createEtherscanClient({
  apiUrl: "https://api.bscscan.com/api",
  apiKey: process.env.BSCSCAN_API_KEY || "",
  rateLimiterKey: "bscscan",
});
