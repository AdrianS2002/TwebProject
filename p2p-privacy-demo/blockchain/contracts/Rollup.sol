// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Rollup {
    address public sequencer;

    struct Batch {
        uint256 batchId;
        bytes32 merkleRoot;
        uint256 txCount;
        uint256 timestamp;
        address submittedBy;
    }

    Batch[] public batches;

    event BatchSubmitted(
        uint256 indexed batchId,
        bytes32 indexed merkleRoot,
        uint256 txCount,
        uint256 timestamp
    );

    modifier onlySequencer() {
        require(msg.sender == sequencer, "Only sequencer allowed");
        _;
    }

    constructor() {
        sequencer = msg.sender;
    }

    function submitBatch(bytes32 merkleRoot, uint256 txCount) external onlySequencer {
        require(merkleRoot != bytes32(0), "Invalid Merkle root");
        require(txCount > 0, "Batch cannot be empty");

        uint256 batchId = batches.length;
        batches.push(Batch({
            batchId: batchId,
            merkleRoot: merkleRoot,
            txCount: txCount,
            timestamp: block.timestamp,
            submittedBy: msg.sender
        }));

        emit BatchSubmitted(batchId, merkleRoot, txCount, block.timestamp);
    }

    function getAllBatches() external view returns (Batch[] memory) {
        return batches;
    }

    function getBatchCount() external view returns (uint256) {
        return batches.length;
    }
}