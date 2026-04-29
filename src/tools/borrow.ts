import {
  AgentMode,
  BaseTool,
  type Context,
  PromptGenerator,
} from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import { ContractExecuteTransaction, Hbar } from "@hiero-ledger/sdk";
import { Interface } from "@ethersproject/abi";
import type { z } from "zod";
import {
  RATE_MODE_MAP,
  buildTxBytes,
  contractIdFromEvm,
  defaultGasAndFee,
  getLendingPoolAddress,
  getNetworkKey,
  getTokenAddresses,
  handleResponse,
  getEvmAliasAddress,
  toWei,
  fetchErc20Decimals,
  getAvailableSymbols,
  validateNetworkMismatch,
} from "../bonzo/utils.js";
import { BonzoMarketService } from "../bonzo/bonzo-market-service.js";
import { borrowParameters } from "../bonzo/bonzo.zod.js";

const borrowPrompt = (context: Context = {}) => {
  const contextSnippet = PromptGenerator.getContextSnippet(context);
  const usageInstructions = PromptGenerator.getParameterUsageInstructions();
  return `
${contextSnippet}

This tool borrows tokens from Bonzo (Aave v2) via the LendingPool contract.

Parameters:
- required.tokenSymbol (string)
- required.amount (number|string)
- required.rateMode ("stable"|"variable")
- optional.onBehalfOf (Account ID)
- optional.referralCode (number)
${usageInstructions}
`;
};

type BorrowParams = z.infer<ReturnType<typeof borrowParameters>>;

export const BONZO_BORROW_TOOL = "bonzo_borrow_tool";

export class BonzoBorrowTool extends BaseTool<BorrowParams, BorrowParams> {
  method = BONZO_BORROW_TOOL;
  name = "Bonzo Borrow";
  description: string;
  parameters: ReturnType<typeof borrowParameters>;

  constructor(context: Context) {
    super();
    this.description = borrowPrompt(context);
    this.parameters = borrowParameters(context);
  }

  async normalizeParams(
    params: BorrowParams,
    _context: Context,
    _client: Client,
  ): Promise<BorrowParams> {
    return params;
  }

  async coreAction(params: BorrowParams, context: Context, client: Client) {
    try {
      const { required, optional } = params;
      const { tokenSymbol, amount, rateMode } = required;
      const referralCode = optional?.referralCode ?? 0;
      const network = getNetworkKey(client);
      const { token } = getTokenAddresses(tokenSymbol.toUpperCase(), network);

      let decimals: number | undefined;
      try {
        const reserves = await BonzoMarketService.fetchReserves();
        const reserve = reserves.find((r) => r.symbol.toUpperCase() === tokenSymbol.toUpperCase());
        decimals = reserve?.decimals;
      } catch {}
      if (decimals === undefined) {
        decimals = await fetchErc20Decimals(client, token);
      }

      const amountWei = toWei(amount, decimals);
      const onBehalfOfId = optional?.onBehalfOf || client.operatorAccountId?.toString();
      if (!onBehalfOfId) {
        const message = "Operator account is not set; provide optional.onBehalfOf";
        return handleResponse({ error: message }, message);
      }
      // Use alias-aware resolver so msg.sender and onBehalfOf align for Bonzo checks
      const onBehalfOf = await getEvmAliasAddress(client, onBehalfOfId);

      const lendingPool = getLendingPoolAddress(network);

      // Validate network mismatch
      const networkMismatch = validateNetworkMismatch(client, lendingPool);
      if (networkMismatch) {
        return handleResponse({ error: networkMismatch }, networkMismatch);
      }
      const iface = new Interface(["function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)"]);
      const rate = RATE_MODE_MAP[rateMode];
      const data = iface.encodeFunctionData("borrow", [token, amountWei, rate, referralCode, onBehalfOf]);

      // Gas/fee configuration with per-tool env overrides
      const base = defaultGasAndFee("heavy");
      const gasOverride = 2_000_000;
      const feeOverride = 5_000_000;
      const gas = Number.isFinite(gasOverride) && gasOverride > 0 ? Math.trunc(gasOverride) : base.gas;
      const fee = Number.isFinite(feeOverride) && feeOverride > 0 ? new Hbar(feeOverride) : base.fee;

      const tx = new ContractExecuteTransaction()
        .setContractId(contractIdFromEvm(lendingPool))
        .setGas(gas)
        .setFunctionParameters(Buffer.from(data.slice(2), "hex"))
        .setMaxTransactionFee(fee);

      if (context.mode === AgentMode.AUTONOMOUS) {
        const resp = await tx.execute(client);
        const receipt = await resp.getReceipt(client);
        return handleResponse(
          { transactionId: resp.transactionId.toString(), status: receipt.status.toString() },
          `Borrow submitted. Status: ${receipt.status.toString()} TxId: ${resp.transactionId.toString()}`,
        );
      }

      const bytes = await buildTxBytes(tx, client);
      return handleResponse({ bytes }, `Transaction prepared. Hex: ${bytes.toString("hex")}`);
    } catch (error) {
      console.error("[BonzoBorrow] Error:", error);
      const network = getNetworkKey(client);
      const available = getAvailableSymbols(network).join(", ");
      const message = error instanceof Error
        ? `Borrow failed: ${error.message}. Network: ${network}. Available tokens: ${available || "<none>"}`
        : "Borrow failed";
      return handleResponse({ error: message }, message);
    }
  }

  override async shouldSecondaryAction(_coreActionResult: unknown, _context: Context) {
    return false;
  }

  async secondaryAction(_request: unknown, _client: Client, _context: Context) {
    return null;
  }
}

const tool = (context: Context) => new BonzoBorrowTool(context);

export default tool;
