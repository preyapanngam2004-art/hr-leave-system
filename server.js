/* === 1. SETUP (ตั้งค่า) === */
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer'); 
const path = require('path');
const fs = require('fs');
const axios = require('axios'); 

/* === 🟢 ตั้งค่า LINE MESSAGING API (ใส่รหัสให้แล้ว) === */
const LINE_CHANNEL_ACCESS_TOKEN = '97hR08E0+Pbur/ocIwvN4a80dEycrLG7HNWox03G06akpdp9p1wA7/z++4gAROKwNDE4/LV/czWWgc67Yjv2ibku6V1rgcflAZumrFZKuFCMG4kmXOrV0MUtUo7ZGcxpM7C19S1bkYZfTYJgL1HMiAdB04t89/1O/w1cDnyilFU='; 

// ตั้งค่าให้ส่งเข้ามือถือคุณ (ทั้งในฐานะหัวหน้า และ พนักงาน)
const MANAGER_LINE_ID = 'U53244e85414f202101f1c53c435f644d6'; 
const EMPLOYEE_TEST_ID = 'U53244e85414f202101f1c53c435f644d6'; 

const app = express();
app.use(cors());
app.use(express.json());

// Static Files & Uploads
app.use(express.static(path.join(__dirname))); 
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)){ fs.mkdirSync(uploadDir); }
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Root Route
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'login.html')); }); 


/* === 2. DATABASE CONNECTION (Clever Cloud) === */
const pool = mysql.createPool({
    host: 'beo7a5e1cdpfctprqfrk-mysql.services.clever-cloud.com',
    user: 'utbsrjivbaog6owj',
    password: 'sSoDsDIaDFdD6Ifl0Y4t',
    database: 'beo7a5e1cdpfctprqfrk',
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

/* === SETUP MULTER === */
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, 'uploads/'); },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

/* === ฟังก์ชันช่วยส่ง LINE (ระบุผู้รับได้) === */
async function sendLineMessage(toUserId, text) {
    try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to: toUserId,
            messages: [{ type: 'text', text: text }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
            }
        });
        console.log(`ส่ง LINE สำเร็จ (ถึง: ${toUserId})`);
    } catch (error) {
        console.error('ส่ง LINE พลาด:', error.response ? error.response.data : error.message);
    }
}


/* === 4. API ENDPOINTS === */

// --- API 1: Login ---
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const [rows] = await pool.query("SELECT * FROM employees WHERE Username = ? AND Password = ?", [username, password]);
        if (rows.length > 0) { res.json({ success: true, user: rows[0] }); } 
        else { res.status(401).json({ success: false, message: 'ชื่อผู้ใช้ หรือ รหัสผ่านไม่ถูกต้อง' }); }
    } catch (error) { res.status(500).json({ success: false, message: 'Server Error: ' + error.message }); }
});

// --- API 2: Pending Requests ---
app.get('/api/pending-requests/:managerId', async (req, res) => {
    try {
        const { managerId } = req.params; 
        const [rows] = await pool.query(`
            SELECT lr.Request_ID, lr.StartDate, lr.Reason, lr.AttachmentFile, e.FirstName, e.LastName, lt.TypeName
            FROM leaverequests lr
            JOIN employees e ON lr.Emp_ID = e.Emp_ID
            JOIN leavetypes lt ON lr.LeaveType_ID = lt.LeaveType_ID
            WHERE lr.Approver_ID = ? AND lr.Status = 'Pending' ORDER BY lr.StartDate ASC`, [managerId]);
        res.json(rows);
    } catch (error) { res.status(500).json({ message: 'Server Error: ' + error.message }); }
});

// --- API 3: Approve/Reject (👉 แจ้งผลไปหาพนักงาน) ---
app.post('/api/process-request', async (req, res) => {
    const { requestId, newStatus } = req.body; 
    try {
        // 1. อัปเดต DB
        await pool.query("UPDATE leaverequests SET Status = ?, ApprovalDate = NOW() WHERE Request_ID = ?", [newStatus, requestId]);
        res.json({ message: `ดำเนินการ "${newStatus}" สำเร็จ` });

        // 2. ส่ง LINE แจ้งผล (ส่งหาพนักงาน)
        (async () => {
            try {
                const [rows] = await pool.query(`
                    SELECT e.FirstName, lt.TypeName
                    FROM leaverequests lr
                    JOIN employees e ON lr.Emp_ID = e.Emp_ID
                    JOIN leavetypes lt ON lr.LeaveType_ID = lt.LeaveType_ID
                    WHERE lr.Request_ID = ?`, [requestId]);

                if (rows.length > 0) {
                    const employee = rows[0];
                    const statusIcon = newStatus === 'Approved' ? '✅' : '❌';
                    const statusInThai = newStatus === 'Approved' ? 'อนุมัติ' : 'ปฏิเสธ';
                    
                    // ข้อความระบุชัดเจนว่าถึงพนักงาน
                    const message = `${statusIcon} เรียน พนักงานคุณ ${employee.FirstName}\nเรื่อง: ขอลา "${employee.TypeName}"\nผลการพิจารณา: ${statusInThai}\n\n(ระบบบันทึกผลแล้ว)`;
                    
                    // ส่งไปที่ตัวแปร EMPLOYEE_TEST_ID
                    await sendLineMessage(EMPLOYEE_TEST_ID, message);
                }
            } catch (err) { console.error('Database Error:', err); }
        })();

    } catch (error) { if (!res.headersSent) res.status(500).json({ message: 'Server Error: ' + error.message }); }
});


// --- API 4: Submit Leave (👉 แจ้งเตือนไปหาหัวหน้า) ---
app.post('/api/submit-leave', upload.single('attachmentFile'), async (req, res) => {
    const { empId, leaveType, startDate, endDate, reason, managerId } = req.body;
    const attachmentPath = req.file ? req.file.filename : null; 
    const year = new Date(startDate).getFullYear();
    
    try {
        const [balanceRows] = await pool.query("SELECT RemainingDays FROM leavebalances WHERE Emp_ID = ? AND LeaveType_ID = ? AND Year = ?", [empId, leaveType, year]);
        if (balanceRows.length === 0 || balanceRows[0].RemainingDays < 1) { 
            return res.status(400).json({ message: 'ใบลาไม่พอ หรือ ไม่พบโควต้าสำหรับปีนี้' });
        }
        
        // 1. บันทึกลง DB
        await pool.query("INSERT INTO leaverequests (Emp_ID, LeaveType_ID, StartDate, EndDate, Reason, Approver_ID, Status, AttachmentFile) VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?)", 
        [empId, leaveType, startDate, endDate, reason, managerId, attachmentPath]);
        res.json({ message: 'ส่งใบลาสำเร็จ!' });

        // 2. ส่ง LINE แจ้งหัวหน้า (ส่งหาหัวหน้า)
        (async () => {
            try {
                const [employeeRows] = await pool.query("SELECT FirstName, LastName FROM employees WHERE Emp_ID = ?", [empId]);
                if (employeeRows.length > 0) {
                    const employeeName = `${employeeRows[0].FirstName} ${employeeRows[0].LastName}`;
                    
                    // ข้อความระบุชัดเจนว่าถึงหัวหน้า
                    const message = `🔔 เรียน หัวหน้าแผนก\nมีคำขอใบลาใหม่จาก: ${employeeName}\nวันที่: ${startDate} ถึง ${endDate}\nเหตุผล: ${reason}\n\nกรุณาตรวจสอบเพื่ออนุมัติ`;
                    
                    // ส่งไปที่ตัวแปร MANAGER_LINE_ID
                    await sendLineMessage(MANAGER_LINE_ID, message);
                }
            } catch (err) { console.error('Database Error:', err.message); }
        })();

    } catch (error) { if (!res.headersSent) res.status(500).json({ message: 'Server Error: ' + error.message }); }
});

// --- API 5, 6, 7 (คงเดิม) ---
app.get('/api/leave-history/:empId', async (req, res) => { try { const { empId } = req.params; const [rows] = await pool.query(`SELECT lr.*, lt.TypeName FROM leaverequests lr JOIN leavetypes lt ON lr.LeaveType_ID = lt.LeaveType_ID WHERE lr.Emp_ID = ? ORDER BY lr.StartDate DESC`, [empId]); res.json(rows); } catch (error) { res.status(500).json({ message: 'Server Error: ' + error.message }); } });
app.get('/api/report', async (req, res) => { try { const { startDate, endDate, deptId, leaveTypeId, status } = req.query; let sql = `SELECT lr.StartDate, lr.EndDate, lr.Status, lr.AttachmentFile, e.FirstName, e.LastName, d.DeptName, lt.TypeName FROM leaverequests lr JOIN employees e ON lr.Emp_ID = e.Emp_ID JOIN leavetypes lt ON lr.LeaveType_ID = lt.LeaveType_ID JOIN departments d ON e.Dept_ID = d.Dept_ID WHERE 1=1 `; const params = []; if (startDate) { sql += " AND lr.StartDate >= ?"; params.push(startDate); } if (endDate) { sql += " AND lr.EndDate <= ?"; params.push(endDate); } if (deptId) { sql += " AND e.Dept_ID = ?"; params.push(deptId); } if (leaveTypeId) { sql += " AND lr.LeaveType_ID = ?"; params.push(leaveTypeId); } if (status) { sql += " AND lr.Status = ?"; params.push(status); } sql += " ORDER BY lr.StartDate DESC"; const [rows] = await pool.query(sql, params); res.json(rows); } catch (error) { res.status(500).json({ message: 'Server Error: ' + error.message }); } });
app.get('/api/quotas/:empId', async (req, res) => { try { const { empId } = req.params; const year = new Date().getFullYear(); const [rows] = await pool.query(`SELECT lb.RemainingDays, lt.TypeName FROM leavebalances lb JOIN leavetypes lt ON lb.LeaveType_ID = lt.LeaveType_ID WHERE lb.Emp_ID = ? AND lb.Year = ? ORDER BY lt.LeaveType_ID ASC`, [empId, year]); res.json(rows); } catch (error) { res.status(500).json({ message: 'Server Error: ' + error.message }); } });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server is listening on port ${PORT}`); });