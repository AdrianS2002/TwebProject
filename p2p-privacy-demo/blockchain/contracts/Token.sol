// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Token {
    string public name = "Regulated Euro Stablecoin";
    string public symbol = "EURS";
    uint8 public decimals = 18;
    uint256 public totalSupply;

    address public financialInstitution;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isWhitelisted;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event WhitelistUpdated(address indexed account, bool status);

    modifier onlyFI() {
        require(msg.sender == financialInstitution, "Only Financial Institution allowed");
        _;
    }

    modifier onlyWhitelisted(address account) {
        require(isWhitelisted[account], "Account is not KYC whitelisted");
        _;
    }

    constructor() {
        financialInstitution = msg.sender;
        isWhitelisted[msg.sender] = true;
    }

    function setWhitelist(address account, bool status) external onlyFI {
        isWhitelisted[account] = status;
        emit WhitelistUpdated(account, status);
    }

    function mint(address to, uint256 amount) external onlyFI onlyWhitelisted(to) {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external onlyWhitelisted(msg.sender) returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount)
        external
        onlyWhitelisted(msg.sender)
        onlyWhitelisted(to)
        returns (bool)
    {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        onlyWhitelisted(from)
        onlyWhitelisted(to)
        returns (bool)
    {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}