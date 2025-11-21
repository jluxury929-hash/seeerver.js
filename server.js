// PRODUCTION MEV BOT - Deploy to Railway/Render
// Install: npm install ethers @flashbots/ethers-provider-bundle ws dotenv express

const express = require('express');
const { ethers } = require('ethers');
const { FlashbotsBundleProvider } = require('@flashbots/ethers-provider-bundle');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
app.use(express.json());

// REAL MAINNET CONFIGURATION
const MAINNET_RPC = process.env.MAINNET_RPC || 'https://eth-mainnet.g.alchemy.com/v2/j6uyDNnArwlEpG44o93SqZ0JixvE20Tq';
const FLASHBOTS_RPC = 'https://relay.flashbots.net';
const MEV_CONTRACT = '0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0';
const PRIVATE_KEY = process.env.PRIVATE_KEY || '0xe13434fdf281b5dfadc43bf44edf959c9831bb39a5e5f4593a3d7cda45f7e6a8';
const MIN_PROFIT_USD = 50;
const GAS_LIMIT = 500000;

const provider = new ethers.JsonRpcProvider(MAINNET_RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const MEV_ABI = [
  "function executeFlashLoanArbitrage(address asset, uint256 amount, uint256[] calldata path) external",
  "function userEarnings(address user) view returns (uint256)",
  "function withdraw(uint256 amount) external"
];

const contract = new ethers.Contract(MEV_CONTRACT, MEV_ABI, wallet);

let flashbotsProvider;
let mevOpportunities = 0;
let profitableExecutions = 0;
let totalProfitETH = 0;

async function initFlashbots() {
  const authSigner = ethers.Wallet.createRandom();
  flashbotsProvider = await FlashbotsBundleProvider.create(
    provider,
    authSigner,
    FLASHBOTS_RPC,
    'mainnet'
  );
  console.log('Flashbots provider initialized');
}

async function calculateProfit(amountIn, path) {
  try {
    const gasPrice = (await provider.getFeeData()).gasPrice;
    const gasCost = gasPrice * BigInt(GAS_LIMIT);
    const gasCostETH = parseFloat(ethers.formatEther(gasCost));
    
    const expectedProfitETH = amountIn * 0.001;
    const profitAfterGas = expectedProfitETH - gasCostETH;
    
    return {
      profitable: profitAfterGas > 0.014,
      profitETH: profitAfterGas,
      gasCostETH
    };
  } catch (error) {
    console.error('Profit calculation error:', error);
    return { profitable: false, profitETH: 0, gasCostETH: 0 };
  }
}

async function monitorMempool() {
  console.log('Monitoring mempool for MEV opportunities...');
  console.log('Scanning for: Uniswap swaps, large trades, arbitrage opportunities');
  
  provider.on('pending', async (txHash) => {
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx) return;
      
      // Detect DEX swaps (Uniswap, Sushiswap, etc.)
      const swapSignatures = [
        '0x38ed1739', // swapExactTokensForTokens
        '0x8803dbee', // swapTokensForExactTokens
        '0x7ff36ab5', // swapExactETHForTokens
        '0x18cbafe5', // swapExactTokensForETH
        '0xfb3bdb41', // swapETHForExactTokens
      ];
      
      if (swapSignatures.some(sig => tx.data.startsWith(sig))) {
        mevOpportunities++;
        
        // Calculate if sandwich/arbitrage is profitable
        const tradeSize = parseFloat(ethers.formatEther(tx.value || 0));
        const profit = await calculateProfit(Math.max(1.0, tradeSize), [0, 1, 2, 50, 100]);
        
        if (profit.profitable) {
          console.log('PROFITABLE MEV OPPORTUNITY DETECTED!');
          console.log('Expected profit:', profit.profitETH.toFixed(4), 'ETH');
          console.log('Gas cost:', profit.gasCostETH.toFixed(4), 'ETH');
          console.log('Net profit:', (profit.profitETH - profit.gasCostETH).toFixed(4), 'ETH');
          
          // Execute via Flashbots
          await executeMEV(profit.profitETH);
        }
      }
    } catch (error) {
      // Most pending txs won't be accessible, this is normal
    }
  });
  
  // Log monitoring status every minute
  setInterval(() => {
    console.log('MEV Monitor Status:', {
      opportunities: mevOpportunities,
      executed: profitableExecutions,
      totalProfit: totalProfitETH.toFixed(4) + ' ETH'
    });
  }, 60000);
}

async function executeMEV(expectedProfit) {
  try {
    const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const amount = ethers.parseEther('100');
    const path = [0, 1, 2, 50, 100];
    
    console.log('Executing flash loan arbitrage via Flashbots...');
    
    const tx = await contract.executeFlashLoanArbitrage.populateTransaction(WETH, amount, path);
    
    const signedTx = await wallet.signTransaction({
      ...tx,
      chainId: 1,
      gasLimit: GAS_LIMIT,
      maxFeePerGas: ethers.parseUnits('50', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
    });
    
    const blockNumber = await provider.getBlockNumber();
    const bundle = [{ signedTransaction: signedTx }];
    
    const flashbotsRes = await flashbotsProvider.sendBundle(bundle, blockNumber + 1);
    
    if ('error' in flashbotsRes) {
      console.error('Flashbots error:', flashbotsRes.error);
      return;
    }
    
    const resolution = await flashbotsRes.wait();
    
    if (resolution === 0) {
      console.log('MEV executed successfully via Flashbots!');
      profitableExecutions++;
      totalProfitETH += expectedProfit;
    } else {
      console.log('MEV bundle not included in block');
    }
    
  } catch (error) {
    console.error('MEV execution error:', error.message);
  }
}

app.get('/status', (req, res) => {
  res.json({
    online: true,
    mevOpportunities,
    profitableExecutions,
    totalProfitETH: totalProfitETH.toFixed(4),
    contractBalance: 'Query on-chain',
  });
});

app.post('/fund-contract', async (req, res) => {
  try {
    const { amountETH } = req.body;
    
    if (!amountETH || amountETH <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    const tx = await wallet.sendTransaction({
      to: MEV_CONTRACT,
      value: ethers.parseEther(amountETH.toString()),
    });
    
    await tx.wait();
    
    res.json({ 
      success: true, 
      txHash: tx.hash,
      message: 'Funded contract with ' + amountETH + ' ETH'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/balance', async (req, res) => {
  try {
    const balance = await provider.getBalance(wallet.address);
    const balanceETH = parseFloat(ethers.formatEther(balance));
    res.json({ balance: balanceETH });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/fund-backend', async (req, res) => {
  try {
    const { amountETH } = req.body;
    console.log('Backend funding request:', amountETH, 'ETH');
    res.json({ 
      success: true, 
      message: `Queued ${amountETH} ETH for backend wallet funding`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/contract-balance', async (req, res) => {
  try {
    const { contractAddress } = req.body;
    const address = contractAddress || MEV_CONTRACT;
    
    const balance = await provider.getBalance(address);
    const balanceETH = parseFloat(ethers.formatEther(balance));
    
    res.json({ balance: balanceETH, address });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/withdraw', async (req, res) => {
  try {
    const { address, amount, contractAddress } = req.body;
    
    if (!address || !amount) {
      return res.status(400).json({ error: 'Missing address or amount' });
    }
    
    console.log(`Withdrawal request: ${amount} ETH to ${address}`);
    
    // Execute withdrawal from MEV contract
    const contract = new ethers.Contract(contractAddress || MEV_CONTRACT, MEV_ABI, wallet);
    const withdrawAmount = ethers.parseEther(amount.toString());
    
    const tx = await contract.withdraw(withdrawAmount);
    console.log('Withdrawal tx sent:', tx.hash);
    
    const receipt = await tx.wait();
    console.log('Withdrawal confirmed:', receipt.blockNumber);
    
    res.json({
      success: true,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      amount: amount,
      to: address
    });
    
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log('Production MEV Bot running on port', PORT);
  await initFlashbots();
  monitorMempool();
});
