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
  buildTxBytes,
  contractIdFromEvm,
  defaultGasAndFee,
  getLendingPoolAddress,
  getNetworkKey,
  getTokenAddresses,
  handleResponse,
  maxUint256,
  getEvmAliasAddress,
  toWei,
  fetchErc20Decimals,
  getAvailableSymbols,
  validateNetworkMismatch,
} from "../bonzo/utils.js";
import { BonzoMarketService } from "../bonzo/bonzo-market-service.js";
import { withdrawParameters } from "../bonzo/bonzo.zod.js";

const withdrawPrompt = (context: Context = {}) => {
  const contextSnippet = PromptGenerator.getContextSnippet(context);
  const usageInstructions = PromptGenerator.getParameterUsageInstructions();
  return `
${contextSnippet}

This tool withdraws supplied tokens from Bonzo (Aave v2) via the LendingPool contract.

Parameters:
- required.tokenSymbol (string)
- required.amount (number|string)
- optional.to (Account ID)
- optional.withdrawAll (boolean)
${usageInstructions}
`;
};

type WithdrawParams = z.infer<ReturnType<typeof withdrawParameters>>;

export const BONZO_WITHDRAW_TOOL = "bonzo_withdraw_tool";

export class BonzoWithdrawTool extends BaseTool<WithdrawParams, WithdrawParams> {
  method = BONZO_WITHDRAW_TOOL;
  name = "Bonzo Withdraw";
  description: string;
  parameters: ReturnType<typeof withdrawParameters>;

  constructor(context: Context) {
    super();
    this.description = withdrawPrompt(context);
    this.parameters = withdrawParameters(context);
  }

  async normalizeParams(
    params: WithdrawParams,
    _context: Context,
    _client: Client,
  ): Promise<WithdrawParams> {
    return params;
  }

  async coreAction(params: WithdrawParams, context: Context, client: Client) {
    try {
      const { required, optional } = params;
      const { tokenSymbol, amount } = required;
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

      const targetId = optional?.to || client.operatorAccountId?.toString();
      if (!targetId) {
        const message = "Operator account is not set; provide optional.to";
        return handleResponse({ error: message }, message);
      }
      const to = await getEvmAliasAddress(client, targetId);

      const amountWei = optional?.withdrawAll ? maxUint256 : toWei(amount, decimals);

      const lendingPool = getLendingPoolAddress(network);

      // Validate network mismatch
      const networkMismatch = validateNetworkMismatch(client, lendingPool);
      if (networkMismatch) {
        return handleResponse({ error: networkMismatch }, networkMismatch);
      }
      const iface = new Interface(["function withdraw(address asset, uint256 amount, address to)"]);
      const data = iface.encodeFunctionData("withdraw", [token, amountWei, to]);

      // Gas/fee configuration with per-tool env overrides
      const base = defaultGasAndFee("light");
      const gasOverride = 1_000_000;
      const feeOverride = 3_000_000;
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
          `Withdraw submitted. Status: ${receipt.status.toString()} TxId: ${resp.transactionId.toString()}`,
        );
      }

      const bytes = await buildTxBytes(tx, client);
      return handleResponse({ bytes }, `Transaction prepared. Hex: ${bytes.toString("hex")}`);
    } catch (error) {
      console.error("[BonzoWithdraw] Error:", error);
      const network = getNetworkKey(client);
      const available = getAvailableSymbols(network).join(", ");
      const message = error instanceof Error
        ? `Withdraw failed: ${error.message}. Network: ${network}. Available tokens: ${available || "<none>"}`
        : "Withdraw failed";
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

const tool = (context: Context) => new BonzoWithdrawTool(context);

export default tool;
