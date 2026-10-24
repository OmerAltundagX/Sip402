// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Sip402} from "../src/Sip402.sol";

contract DeployScript is Script {
    function run() external returns (Sip402 sip) {
        vm.startBroadcast();
        sip = new Sip402();
        vm.stopBroadcast();
        console.log("Sip402 deployed at", address(sip));
    }
}
