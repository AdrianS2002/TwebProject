// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Token.sol";

contract TokenPortal {
    Token public token;
    address public sequencer;

    struct Deposit {
        uint256 id;
        bytes32 secretHash;
        uint256 amount;
        bool claimed;
        uint256 timestamp;
    }

    Deposit[] public deposits;

    event DepositLocked(uint256 indexed depositId, bytes32 indexed secretHash, uint256 amount, uint256 timestamp);
    event DepositClaimed(uint256 indexed depositId, bytes32 indexed secretHash);

    modifier onlySequencer() {
        require(msg.sender == sequencer, "Only sequencer allowed");
        _;
    }

    constructor(address _tokenAddress) {
        token = Token(_tokenAddress);
        sequencer = msg.sender;
    }

    // Utilizatorul (ex: Buyer) blocheaza tokeni pe L1 trimitand doar hash-ul secretului
    function depositToL2(uint256 amount, bytes32 secretHash) external returns (uint256) {
        require(amount > 0, "Amount must be > 0");
        require(secretHash != bytes32(0), "Invalid secret hash");

        bool success = token.transferFrom(msg.sender, address(this), amount);
        require(success, "Token transfer failed");

        uint256 depositId = deposits.length;
        deposits.push(Deposit({
            id: depositId,
            secretHash: secretHash,
            amount: amount,
            claimed: false,
            timestamp: block.timestamp
        }));

        emit DepositLocked(depositId, secretHash, amount, block.timestamp);
        return depositId;
    }

    // Sequencer-ul L2 marcheaza mesajul ca folosit (nullifier) dupa verificarea secretului pe L2
    function markClaimed(uint256 depositId) external onlySequencer {
        require(depositId < deposits.length, "Invalid depositId");
        require(!deposits[depositId].claimed, "Already claimed");

        deposits[depositId].claimed = true;
        emit DepositClaimed(depositId, deposits[depositId].secretHash);
    }

    function getDepositsCount() external view returns (uint256) {
        return deposits.length;
    }

    function getAllDeposits() external view returns (Deposit[] memory) {
        return deposits;
    }

    mapping(bytes32 => bool) public processedWithdrawals;

    event WithdrawalProcessed(address indexed recipient, uint256 amount, bytes32 l2TxHash);

    function withdrawToL1(
        address recipient,
        uint256 amount,
        bytes32 l2TxHash
    ) external {
        require(!processedWithdrawals[l2TxHash], "Withdrawal already processed");
        require(token.balanceOf(address(this)) >= amount, "Insufficient portal liquidity");

        processedWithdrawals[l2TxHash] = true;
        require(token.transfer(recipient, amount), "L1 transfer failed");

        emit WithdrawalProcessed(recipient, amount, l2TxHash);
    }
}